import { Injectable } from '@nestjs/common';
import { BigQuery } from '@google-cloud/bigquery';

@Injectable()
export class BigQueryService {
  private client: BigQuery;

  constructor() {
    this.client = new BigQuery({
      projectId: process.env.BIGQUERY_PROJECT_ID,
    });
  }

  async query<T = any>(
    query: string,
    params?: Record<string, any>,
  ): Promise<T[]> {
    const [job] = await this.client.createQueryJob({ query, params });
    const [rows] = await job.getQueryResults();
    return rows as T[];
  }

  async queryStream(query: string, params?: Record<string, any>) {
    const [job] = await this.client.createQueryJob({ query, params });
    return job.getQueryResultsStream();
  }
}
