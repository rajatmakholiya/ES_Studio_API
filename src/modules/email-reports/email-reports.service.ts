import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import * as nodemailer from 'nodemailer';
import { ReportRecipient } from './entities/report-recipient.entity';
import { CsvGeneratorService } from './csv-generators.service';

@Injectable()
export class EmailReportsService {
    private readonly logger = new Logger(EmailReportsService.name);
    private transporter: nodemailer.Transporter | null = null;

    constructor(
        @InjectRepository(ReportRecipient)
        private readonly recipientRepo: Repository<ReportRecipient>,
        private readonly csvGenerator: CsvGeneratorService,
    ) {
        this.initTransporter();
    }

    private initTransporter() {
        const host = process.env.SMTP_HOST;
        const port = parseInt(process.env.SMTP_PORT || '587', 10);
        const user = process.env.SMTP_USER;
        const pass = process.env.SMTP_PASS;

        if (!host || !user || !pass) {
            this.logger.warn('SMTP not configured — emails will be disabled. Set SMTP_HOST, SMTP_USER, SMTP_PASS.');
            return;
        }

        this.transporter = nodemailer.createTransport({
            host,
            port,
            secure: port === 465,
            auth: { user, pass },
        });

        this.logger.log(`SMTP transporter initialized: ${host}:${port}`);
    }

    // ═══════════════════════════════════════════════════════
    // RECIPIENT CRUD
    // ═══════════════════════════════════════════════════════

    async listRecipients(): Promise<ReportRecipient[]> {
        return this.recipientRepo.find({ order: { createdAt: 'ASC' } });
    }

    async addRecipient(email: string): Promise<ReportRecipient> {
        const normalized = email.trim().toLowerCase();
        const existing = await this.recipientRepo.findOne({ where: { email: normalized } });
        if (existing) {
            // Reactivate if it was deactivated
            existing.isActive = true;
            return this.recipientRepo.save(existing);
        }
        return this.recipientRepo.save(this.recipientRepo.create({ email: normalized }));
    }

    async removeRecipient(id: number): Promise<void> {
        await this.recipientRepo.delete(id);
    }

    // ═══════════════════════════════════════════════════════
    // CRON JOBS
    // ═══════════════════════════════════════════════════════

    /** Daily report — 7:00 AM IST every day. Sends yesterday's data. */
    @Cron('0 7 * * *', { timeZone: 'Asia/Kolkata' })
    async handleDailyReport() {
        this.logger.log('⏰ Daily report cron triggered');
        const yesterday = this.getDateStr(-1);
        await this.sendReport('daily', yesterday, yesterday);
    }

    /** Weekly report — 7:00 AM IST every Monday. Sends previous Mon-Sun. */
    @Cron('0 7 * * 1', { timeZone: 'Asia/Kolkata' })
    async handleWeeklyReport() {
        this.logger.log('⏰ Weekly report cron triggered');
        // Previous Monday to previous Sunday
        const today = new Date();
        const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon
        const prevMonday = new Date(today);
        prevMonday.setDate(today.getDate() - dayOfWeek - 6); // go back to previous Monday
        const prevSunday = new Date(prevMonday);
        prevSunday.setDate(prevMonday.getDate() + 6);

        const startStr = prevMonday.toISOString().split('T')[0];
        const endStr = prevSunday.toISOString().split('T')[0];

        await this.sendReport('weekly', startStr, endStr);
    }

    /** Manual trigger for testing */
    async sendTestReport(): Promise<{ success: boolean; message: string }> {
        const yesterday = this.getDateStr(-1);
        return this.sendReport('test', yesterday, yesterday);
    }

    // ═══════════════════════════════════════════════════════
    // CORE SEND LOGIC
    // ═══════════════════════════════════════════════════════

    private async sendReport(
        type: 'daily' | 'weekly' | 'test',
        startDate: string,
        endDate: string,
    ): Promise<{ success: boolean; message: string }> {
        if (!this.transporter) {
            const msg = 'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env';
            this.logger.warn(msg);
            return { success: false, message: msg };
        }

        const recipients = await this.recipientRepo.find({ where: { isActive: true } });
        if (recipients.length === 0) {
            const msg = 'No active recipients configured';
            this.logger.warn(msg);
            return { success: false, message: msg };
        }

        const toList = recipients.map(r => r.email).join(', ');
        const isRange = startDate !== endDate;
        const dateLabel = isRange ? `${startDate} to ${endDate}` : startDate;
        const typeLabel = type === 'weekly' ? 'Weekly' : type === 'test' ? 'Test' : 'Daily';

        this.logger.log(`Generating ${typeLabel} report CSVs for ${dateLabel}...`);

        try {
            // Generate all 3 CSVs in parallel
            const [trafficCSV, revenueCSV, metaCSV] = await Promise.all([
                this.csvGenerator.generateTrafficCSV(startDate, endDate),
                this.csvGenerator.generateRevenueCSV(startDate, endDate),
                this.csvGenerator.generateMetaReportCSV(startDate, endDate),
            ]);

            const filePrefix = isRange
                ? `${startDate}_to_${endDate}`
                : startDate;

            const attachments = [
                {
                    filename: `Traffic_Report_${filePrefix}.csv`,
                    content: trafficCSV,
                    contentType: 'text/csv',
                },
                {
                    filename: `Revenue_Report_${filePrefix}.csv`,
                    content: revenueCSV,
                    contentType: 'text/csv',
                },
                {
                    filename: `Meta_Overview_Report_${filePrefix}.csv`,
                    content: metaCSV,
                    contentType: 'text/csv',
                },
            ];

            const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER || 'reports@studio.local';

            // Parse revenue data for inline HTML table
            const revenueData = this.parseRevenueCSV(revenueCSV);

            await this.transporter.sendMail({
                from: fromAddr,
                to: toList,
                subject: `📊 ${typeLabel} Report — ${dateLabel} | ES Studio`,
                html: this.buildEmailHtml(typeLabel, dateLabel, trafficCSV, revenueCSV, metaCSV, revenueData),
                attachments,
            });

            const msg = `${typeLabel} report sent to ${recipients.length} recipient(s) for ${dateLabel}`;
            this.logger.log(`✅ ${msg}`);
            return { success: true, message: msg };

        } catch (error: any) {
            const msg = `Failed to send ${typeLabel} report: ${error.message}`;
            this.logger.error(msg, error.stack);
            return { success: false, message: msg };
        }
    }

    // ═══════════════════════════════════════════════════════
    // HTML EMAIL TEMPLATE
    // ═══════════════════════════════════════════════════════

    private parseRevenueCSV(csv: string): {
        teams: { name: string; bonus: string; photo: string; reel: string; story: string; text: string; total: string; pages: { name: string; bonus: string; photo: string; reel: string; story: string; text: string; total: string }[] }[];
        grandTotal: { bonus: string; photo: string; reel: string; story: string; text: string; total: string };
    } {
        const lines = csv.split('\n');
        const teams: any[] = [];
        let grandTotal = { bonus: '$0.00', photo: '$0.00', reel: '$0.00', story: '$0.00', text: '$0.00', total: '$0.00' };
        let currentTeam: any = null;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;

            // Parse CSV line (handle quoted fields)
            const cols = this.parseCSVLine(line);
            const label = cols[0] || '';

            if (label === 'Grand Total') {
                grandTotal = { bonus: cols[1], photo: cols[2], reel: cols[3], story: cols[4], text: cols[5], total: cols[6] };
            } else if (label.endsWith('(Total)')) {
                // Team total row
                currentTeam = {
                    name: label.replace(' (Total)', '').trim(),
                    bonus: cols[1], photo: cols[2], reel: cols[3], story: cols[4], text: cols[5], total: cols[6],
                    pages: [],
                };
                teams.push(currentTeam);
            } else if (currentTeam && label.startsWith('  ')) {
                // Page row (indented)
                currentTeam.pages.push({
                    name: label.trim(),
                    bonus: cols[1], photo: cols[2], reel: cols[3], story: cols[4], text: cols[5], total: cols[6],
                });
            }
        }
        return { teams, grandTotal };
    }

    private parseCSVLine(line: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"' && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else if (ch === '"') {
                    inQuotes = false;
                } else {
                    current += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                result.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        result.push(current);
        return result;
    }

    private buildEmailHtml(
        typeLabel: string,
        dateLabel: string,
        trafficCSV: string,
        revenueCSV: string,
        metaCSV: string,
        revenueData: ReturnType<typeof EmailReportsService.prototype.parseRevenueCSV>,
    ): string {
        const trafficRows = trafficCSV.split('\n').length - 1;
        const metaRows = metaCSV.split('\n').length - 1;

        // Build revenue table rows
        let revenueTableRows = '';
        for (const team of revenueData.teams) {
            // Team header row
            revenueTableRows += `
              <tr style="background:#f3f4f6;">
                <td style="padding:10px 12px;font-weight:700;color:#111827;font-size:13px;border-bottom:1px solid #e5e7eb;">${team.name}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:600;color:#374151;font-size:12px;border-bottom:1px solid #e5e7eb;">${team.bonus}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:600;color:#374151;font-size:12px;border-bottom:1px solid #e5e7eb;">${team.photo}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:600;color:#374151;font-size:12px;border-bottom:1px solid #e5e7eb;">${team.reel}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:600;color:#374151;font-size:12px;border-bottom:1px solid #e5e7eb;">${team.story}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:600;color:#374151;font-size:12px;border-bottom:1px solid #e5e7eb;">${team.text}</td>
                <td style="padding:10px 8px;text-align:right;font-weight:700;color:#059669;font-size:12px;border-bottom:1px solid #e5e7eb;">${team.total}</td>
              </tr>`;
            // Page rows
            for (const page of team.pages) {
                revenueTableRows += `
              <tr>
                <td style="padding:7px 12px 7px 28px;color:#6b7280;font-size:12px;border-bottom:1px solid #f3f4f6;">${page.name}</td>
                <td style="padding:7px 8px;text-align:right;color:#6b7280;font-size:12px;border-bottom:1px solid #f3f4f6;">${page.bonus}</td>
                <td style="padding:7px 8px;text-align:right;color:#6b7280;font-size:12px;border-bottom:1px solid #f3f4f6;">${page.photo}</td>
                <td style="padding:7px 8px;text-align:right;color:#6b7280;font-size:12px;border-bottom:1px solid #f3f4f6;">${page.reel}</td>
                <td style="padding:7px 8px;text-align:right;color:#6b7280;font-size:12px;border-bottom:1px solid #f3f4f6;">${page.story}</td>
                <td style="padding:7px 8px;text-align:right;color:#6b7280;font-size:12px;border-bottom:1px solid #f3f4f6;">${page.text}</td>
                <td style="padding:7px 8px;text-align:right;color:#059669;font-size:12px;border-bottom:1px solid #f3f4f6;">${page.total}</td>
              </tr>`;
            }
        }

        const gt = revenueData.grandTotal;

        return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; margin: 0; padding: 0; }
    .container { max-width: 720px; margin: 0 auto; padding: 32px 16px; }
    .card { background: #fff; border-radius: 12px; padding: 32px; border: 1px solid #e5e7eb; margin-bottom: 16px; }
    h1 { font-size: 20px; color: #111827; margin: 0 0 4px 0; }
    h2 { font-size: 16px; color: #111827; margin: 0 0 16px 0; }
    .subtitle { font-size: 13px; color: #6b7280; margin: 0 0 24px 0; }
    .attachment-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; }
    .attachment-name { font-size: 13px; font-weight: 600; color: #374151; }
    .attachment-meta { font-size: 11px; color: #9ca3af; }
    .footer { text-align: center; padding: 20px 0 0; font-size: 11px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>📊 ${typeLabel} Report</h1>
      <p class="subtitle">${dateLabel}</p>

      <div class="attachment-card">
        <div class="attachment-name">📈 Traffic Report</div>
        <div class="attachment-meta">${trafficRows} page(s) tracked</div>
      </div>

      <div class="attachment-card">
        <div class="attachment-name">💰 Revenue Report</div>
        <div class="attachment-meta">${revenueData.teams.length} team(s), ${revenueData.teams.reduce((s, t) => s + t.pages.length, 0)} page(s)</div>
      </div>

      <div class="attachment-card">
        <div class="attachment-name">📱 Meta Overview</div>
        <div class="attachment-meta">${metaRows} metric(s)</div>
      </div>
    </div>

    <!-- Revenue Breakdown Table -->
    <div class="card" style="padding:24px;">
      <h2>💰 Revenue Breakdown — Page Wise</h2>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:#6b7280;border-bottom:2px solid #e5e7eb;">Team / Page</th>
            <th style="padding:10px 8px;text-align:right;font-size:12px;font-weight:600;color:#6b7280;border-bottom:2px solid #e5e7eb;">Bonus</th>
            <th style="padding:10px 8px;text-align:right;font-size:12px;font-weight:600;color:#6b7280;border-bottom:2px solid #e5e7eb;">Photo</th>
            <th style="padding:10px 8px;text-align:right;font-size:12px;font-weight:600;color:#6b7280;border-bottom:2px solid #e5e7eb;">Reel</th>
            <th style="padding:10px 8px;text-align:right;font-size:12px;font-weight:600;color:#6b7280;border-bottom:2px solid #e5e7eb;">Story</th>
            <th style="padding:10px 8px;text-align:right;font-size:12px;font-weight:600;color:#6b7280;border-bottom:2px solid #e5e7eb;">Text</th>
            <th style="padding:10px 8px;text-align:right;font-size:12px;font-weight:600;color:#059669;border-bottom:2px solid #e5e7eb;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${revenueTableRows}
          <!-- Grand Total -->
          <tr style="background:#f0fdf4;border-top:2px solid #d1d5db;">
            <td style="padding:12px;font-weight:700;color:#111827;font-size:13px;">Grand Total</td>
            <td style="padding:12px 8px;text-align:right;font-weight:700;color:#374151;font-size:12px;">${gt.bonus}</td>
            <td style="padding:12px 8px;text-align:right;font-weight:700;color:#374151;font-size:12px;">${gt.photo}</td>
            <td style="padding:12px 8px;text-align:right;font-weight:700;color:#374151;font-size:12px;">${gt.reel}</td>
            <td style="padding:12px 8px;text-align:right;font-weight:700;color:#374151;font-size:12px;">${gt.story}</td>
            <td style="padding:12px 8px;text-align:right;font-weight:700;color:#374151;font-size:12px;">${gt.text}</td>
            <td style="padding:12px 8px;text-align:right;font-weight:700;color:#059669;font-size:13px;">${gt.total}</td>
          </tr>
        </tbody>
      </table>
      <p style="font-size:11px;color:#9ca3af;margin:12px 0 0;text-align:center;">Full data available in attached CSV files</p>
    </div>

    <div class="footer">
      ES Studio Analytics — Automated Report
    </div>
  </div>
</body>
</html>`;
    }

    // ═══════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════

    private getDateStr(offsetDays: number): string {
        // Use IST (UTC+5:30) for date calculation
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istNow = new Date(now.getTime() + istOffset);
        istNow.setDate(istNow.getDate() + offsetDays);
        return istNow.toISOString().split('T')[0];
    }
}
