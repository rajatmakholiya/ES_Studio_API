import axios from 'axios';

const META_API_VERSION = 'v25.0';
const BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export const exchangeForLongLivedToken = async (shortLivedToken: string) => {
  const url = `${BASE_URL}/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${shortLivedToken}`;
  const response = await axios.get(url);
  return response.data.access_token;
};

export const fetchPermanentPageTokens = async (
  userId: string | 'me',
  accessToken: string,
) => {
  let url = `${BASE_URL}/${userId}/accounts?limit=100&access_token=${accessToken}`;
  const allPages: any[] = [];
  while (url) {
    try {
      const response = await axios.get(url);
      if (response.data.data) allPages.push(...response.data.data);
      url = response.data.paging?.next ? response.data.paging.next : null;
    } catch (error) {
      break;
    }
  }
  return allPages;
};

export const fetchLinkedInstagramAccounts = async (pages: any[]) => {
  const igAccounts: any[] = [];

  for (const page of pages) {
    try {
      const url = `${BASE_URL}/${page.id}?fields=instagram_business_account{id,username,name,profile_picture_url}&access_token=${page.access_token}`;
      const response = await axios.get(url);

      const igData = response.data.instagram_business_account;
      if (igData) {
        igAccounts.push({
          id: igData.id,
          name: igData.name || igData.username,
          username: igData.username,
          profile_picture_url: igData.profile_picture_url,
          access_token: page.access_token,
          fb_page_id: page.id,
        });
      }
    } catch (error) {
      console.warn(
        `[Meta API Warning] Could not fetch IG account for FB Page ${page.id}`,
      );
    }
  }
  return igAccounts;
};

export const fetchProfileBasics = async (
  profileId: string,
  accessToken: string,
  platform: 'facebook' | 'instagram',
) => {
  try {
    const fields =
      platform === 'facebook'
        ? 'id,name,followers_count'
        : 'id,username,name,followers_count,profile_picture_url';
    const url = `${BASE_URL}/${profileId}?fields=${fields}&access_token=${accessToken}`;
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    return null;
  }
};

export const fetchDailySnapshot = async (
  profileId: string,
  accessToken: string,
  platform: 'facebook' | 'instagram',
  sinceUnix: number,
  untilUnix: number,
) => {
  let aggregatedData: any[] = [];

  if (platform === 'facebook') {
    try {
      const fbMetrics =
        'page_impressions_unique,page_post_engagements,page_daily_follows_unique,page_daily_unfollows_unique,page_video_views,page_total_actions,page_views_total';
      const url = `${BASE_URL}/${profileId}/insights?metric=${fbMetrics}&period=day&since=${sinceUnix}&until=${untilUnix}&access_token=${accessToken}`;
      const response = await axios.get(url);
      if (response.data?.data)
        aggregatedData = [...aggregatedData, ...response.data.data];
    } catch (err: any) {
      console.warn(
        `[Meta API Warning] Main FB metrics failed for ${profileId}:`,
        err.response?.data?.error?.message || err.message,
      );
    }

    try {
      const msgUrl = `${BASE_URL}/${profileId}/insights?metric=page_messages_new_conversations_unique,page_messages_total_messaging_connections&period=day&since=${sinceUnix}&until=${untilUnix}&access_token=${accessToken}`;
      const msgRes = await axios.get(msgUrl);
      if (msgRes.data?.data)
        aggregatedData = [...aggregatedData, ...msgRes.data.data];
    } catch (msgError: any) { }
  } else if (platform === 'instagram') {
    const totalValueMetrics = [
      'views',
      'profile_views',
      'website_clicks',
      'total_interactions',
      'follows_and_unfollows',
    ];
    const url1 = `${BASE_URL}/${profileId}/insights?metric=${totalValueMetrics.join(',')}&period=day&metric_type=total_value&since=${sinceUnix}&until=${untilUnix}&access_token=${accessToken}`;

    try {
      const res1 = await axios.get(url1);
      if (res1.data.data)
        aggregatedData = [...aggregatedData, ...res1.data.data];
    } catch (err: any) {
      console.warn(
        `[Meta API Warning] IG total_value metrics failed for ${profileId}:`,
        err.response?.data?.error?.message || err.message,
      );
    }

    const standardMetrics = ['reach'];
    const thirtyDaysAgoUnix = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    if (sinceUnix >= thirtyDaysAgoUnix) {
      standardMetrics.push('follower_count');
    }

    const url2 = `${BASE_URL}/${profileId}/insights?metric=${standardMetrics.join(',')}&period=day&since=${sinceUnix}&until=${untilUnix}&access_token=${accessToken}`;

    try {
      const res2 = await axios.get(url2);
      if (res2.data.data)
        aggregatedData = [...aggregatedData, ...res2.data.data];
    } catch (err: any) {
      console.warn(
        `[Meta API Warning] IG standard metrics failed for ${profileId}:`,
        err.response?.data?.error?.message || err.message,
      );
    }
  }

  return aggregatedData;
};

export async function fetchPostsPaginated(
  profileId: string,
  accessToken: string,
  platform: 'facebook' | 'instagram',
  since: Date,
  until: Date,
) {
  const sinceUnix = Math.floor(since.getTime() / 1000);
  const untilUnix = Math.floor(until.getTime() / 1000);
  let allPosts: any[] = [];

  try {
    const edge = platform === 'facebook' ? 'promotable_posts' : 'media';
    const initialLimit = 25;

    let url = `${BASE_URL}/${profileId}/${edge}?access_token=${accessToken}&since=${sinceUnix}&until=${untilUnix}&limit=${initialLimit}`;

    if (platform === 'facebook') {
      url += `&fields=id,message,created_time,status_type,permalink_url,full_picture,is_published,is_eligible_for_promotion,shares,comments.summary(true),likes.summary(true),from,attachments{media_type,media,url,type}`;
    } else {
      url += `&fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count,owner`;
    }

    const fetchWithFallback = async (
      currentUrl: string,
      currentEdge: string,
    ): Promise<any> => {
      let response = await fetch(currentUrl);
      let data = await response.json();

      if (data.error) {
        if (currentEdge === 'promotable_posts' && data.error.code === 100) {
          console.warn(
            `[Meta API Warning] ${profileId} lacks Ad Account/Permissions. Falling back to published_posts...`,
          );
          const fallbackUrl = currentUrl.replace(
            '/promotable_posts?',
            '/published_posts?',
          );
          response = await fetch(fallbackUrl);
          data = await response.json();
        }

        if (
          data.error &&
          data.error.message?.includes('reduce the amount of data')
        ) {
          console.warn(
            `[Meta API Warning] Payload too large for ${profileId}. Dynamically reducing limit to 10...`,
          );
          const reducedUrl = currentUrl.replace(
            `limit=${initialLimit}`,
            `limit=10`,
          );
          response = await fetch(reducedUrl);
          data = await response.json();
        }

        if (data.error) throw new Error(data.error.message);
      }
      return data;
    };

    while (url) {
      const data = await fetchWithFallback(url, edge);

      if (data.data && data.data.length > 0) {
        allPosts = [...allPosts, ...data.data];
      }

      url = data.paging?.next || null;
    }
  } catch (error) {
    console.error(`Error fetching posts for ${profileId}:`, error);
  }
  return allPosts;
}

export const fetchPostDeepInsights = async (
  postId: string,
  accessToken: string,
  platform: 'facebook' | 'instagram',
  postType: string,
) => {
  try {
    if (platform === 'facebook') {
      const metrics =
        postType === 'video'
          ? 'post_impressions_unique,post_video_views,post_clicks'
          : 'post_impressions_unique,post_clicks';
      const url = `${BASE_URL}/${postId}/insights?metric=${metrics}&access_token=${accessToken}`;
      const response = await axios.get(url);
      return response.data.data || [];
    } else if (platform === 'instagram') {
      const metrics = 'reach,views,saved,shares,total_interactions';
      const url = `${BASE_URL}/${postId}/insights?metric=${metrics}&access_token=${accessToken}`;
      const response = await axios.get(url);
      return response.data.data || [];
    }
    return [];
  } catch (error: any) {
    console.warn(
      `[Meta API Warning] Failed to fetch post insights for ${postId}:`,
      error.response?.data?.error?.message || error.message,
    );
    return [];
  }
};

/**
 * Fetch lifetime demographic data for a profile.
 * Returns gender/age breakdown, top cities, and top countries.
 * Requires 100+ followers to return data.
 */
export const fetchDemographics = async (
  profileId: string,
  accessToken: string,
  platform: 'facebook' | 'instagram',
): Promise<{
  genderAge: Record<string, number>;
  topCities: Record<string, number>;
  topCountries: Record<string, number>;
}> => {
  const result = {
    genderAge: {} as Record<string, number>,
    topCities: {} as Record<string, number>,
    topCountries: {} as Record<string, number>,
  };

  try {
    if (platform === 'facebook') {
      // NOTE: Meta has completely deprecated all Page-level demographic metrics
      // (page_fans_*, page_follows_*, etc.) from the Graph API as of 2024.
      // There is no longer any direct API replacement for Page demographics.
      // We gracefully return empty data to prevent (#100) Invalid Metric errors.
      console.log(
        `[Meta API Info] Demographics access is deprecated by Facebook for Pages. Skipping fetch for ${profileId}.`,
      );
    } else if (platform === 'instagram') {
      const metrics = 'audience_gender_age,audience_city,audience_country';
      const url = `${BASE_URL}/${profileId}/insights?metric=${metrics}&period=lifetime&access_token=${accessToken}`;
      const response = await axios.get(url);

      if (response.data?.data) {
        for (const metric of response.data.data) {
          const value = metric.total_value?.value || metric.values?.[0]?.value;
          if (!value || typeof value !== 'object') continue;

          if (metric.name === 'audience_gender_age') {
            result.genderAge = value;
          } else if (metric.name === 'audience_city') {
            result.topCities = value;
          } else if (metric.name === 'audience_country') {
            result.topCountries = value;
          }
        }
      }
    }
  } catch (error: any) {
    console.warn(
      `[Meta API Warning] Demographics fetch failed for ${profileId}:`,
      error.response?.data?.error?.message || error.message,
    );
  }

  return result;
};

/**
 * Convert a Meta monetary value to dollars.
 *
 * Meta's content_monetization_earnings returns:
 *   { currency: "USD", microAmount: 304898436 }
 *
 * Despite the name "micro", empirical testing shows the divisor is 10^8
 * (i.e. values are in hundredths-of-micro-dollars / nano-cents):
 *   304898436 / 100,000,000 = $3.05  (matches actual dashboard value)
 *
 * Plain numbers (from monetization_approximate_earnings) are already in dollars.
 */
function toDollars(raw: any): number {
  if (raw && typeof raw === 'object' && 'microAmount' in raw) {
    return (Number(raw.microAmount) || 0) / 100_000_000;
  }
  return Number(raw) || 0;
}

/**
 * Fetch daily revenue for a Facebook page (Content Monetization Program).
 * Returns an array of { date, revenue } where revenue is in dollars.
 * Non-CMP pages will return empty/zero gracefully.
 */
export const fetchDailyRevenue = async (
  profileId: string,
  accessToken: string,
  sinceUnix: number,
  untilUnix: number,
): Promise<Array<{ date: string; revenue: number }>> => {
  const results: Array<{ date: string; revenue: number }> = [];

  try {
    const url = `${BASE_URL}/${profileId}/insights?metric=monetization_approximate_earnings&period=day&since=${sinceUnix}&until=${untilUnix}&access_token=${accessToken}`;
    const response = await axios.get(url);

    if (response.data?.data?.[0]?.values) {
      for (const val of response.data.data[0].values) {
        const actualDate = new Date(val.end_time);
        actualDate.setDate(actualDate.getDate() - 1);
        const dateStr = actualDate.toISOString().split('T')[0];
        // Handle both plain numbers and { currency, microAmount } objects
        const revenueInDollars = toDollars(val.value);
        results.push({ date: dateStr, revenue: revenueInDollars });
      }
    }
  } catch (error: any) {
    // Non-CMP pages will throw — this is expected and not an error
    console.warn(
      `[Meta API Info] Revenue data unavailable for ${profileId} (likely not in CMP):`,
      error.response?.data?.error?.message || error.message,
    );
  }

  return results;
};

export interface SegregatedRevenueDay {
  date: string;
  bonus: number;
  photo: number;
  reel: number;
  story: number;
  text: number;
  total: number;
}

/**
 * Normalise the keys Meta returns for content-type earnings into our
 * five canonical buckets plus a `total`.
 *
 * IMPORTANT: `bonus` is populated ONLY when Meta explicitly labels the
 * amount as a bonus/extra/performance payout. Amounts from unrecognised
 * labels (or total-only `microAmount`) are added to `total` only —
 * never to `bonus`. This keeps `bonus` truthful (Meta's public API does
 * not surface a "bonus" field for most pages, so it should be 0 unless
 * Meta literally says so).
 *
 * Skips non-earning keys like `currency` / `end_time`.
 * Handles microAmount objects automatically.
 */
function normaliseCMPValue(raw: Record<string, any>): {
  bonus: number; photo: number; reel: number; story: number; text: number; total: number;
} {
  let bonus = 0, photo = 0, reel = 0, story = 0, text = 0, total = 0;

  for (const [rawKey, rawVal] of Object.entries(raw)) {
    const k = rawKey.toLowerCase();

    // Skip non-earning metadata keys
    if (k === 'currency' || k === 'end_time') continue;

    const v = toDollars(rawVal);
    if (v === 0) continue;

    // Every earning amount contributes to `total` — regardless of
    // whether we can classify it into a breakdown bucket.
    total += v;

    if (k.includes('bonus') || k.includes('extra') || k.includes('performance'))
                                                                      bonus += v;
    else if (k.includes('reel'))                                      reel  += v;
    else if (k.includes('video') || k.includes('in_stream') || k.includes('in-stream'))
                                                                      reel  += v;
    else if (k.includes('story') || k.includes('stories') || k.includes('interstitial'))
                                                                      story += v;
    else if (k.includes('photo') || k.includes('image'))              photo += v;
    else if (k.includes('text') || k.includes('short_form'))          text  += v;
    else if (k === 'microamount') {
      // Single-total response (no breakdown) — counted in `total` only.
    }
    else {
      console.warn(`[Meta API] Unknown CMP earning type "${rawKey}" = ${v} — counted in total only`);
    }
  }

  return { bonus, photo, reel, story, text, total };
}

/**
 * Parse a Meta insights response (array of day values) into SegregatedRevenueDay[].
 * Handles both object values (breakdown) and scalar / microAmount values (total).
 */
function parseSegregatedValues(values: any[]): SegregatedRevenueDay[] {
  const out: SegregatedRevenueDay[] = [];
  for (const val of values) {
    const actualDate = new Date(val.end_time);
    actualDate.setDate(actualDate.getDate() - 1);
    const dateStr = actualDate.toISOString().split('T')[0];

    const v = val.value;

    // { currency: "USD", microAmount: N } — single total, not a breakdown.
    // Meta does not expose bonus in this shape, so bonus stays 0 — total only.
    if (v && typeof v === 'object' && 'microAmount' in v) {
      const n = toDollars(v);
      out.push({ date: dateStr, bonus: 0, photo: 0, reel: 0, story: 0, text: 0, total: n });
    }
    // Object with content-type keys (actual breakdown)
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const parsed = normaliseCMPValue(v);
      out.push({ date: dateStr, ...parsed });
    }
    // Plain number → already in dollars; single total, no breakdown available.
    else if (typeof v === 'number' || typeof v === 'string') {
      const n = Number(v) || 0;
      out.push({ date: dateStr, bonus: 0, photo: 0, reel: 0, story: 0, text: 0, total: n });
    }
  }
  return out;
}

/**
 * Fetch segregated daily revenue breakdown by content type from the
 * Content Monetization Program.
 *
 * Uses the documented approach:
 *   GET /{page-id}/insights?metric=content_monetization_earnings
 *       &breakdown=content_type&period=day
 *
 * Fallback: `monetization_approximate_earnings` (total only, under bonus).
 *
 * Chunks into ≤ 30-day windows so Meta doesn't silently truncate days.
 */
export const fetchSegregatedRevenue = async (
  profileId: string,
  accessToken: string,
  sinceUnix: number,
  untilUnix: number,
): Promise<SegregatedRevenueDay[]> => {
  // --- Build 30-day chunks ---
  const CHUNK_SECS = 30 * 24 * 60 * 60;
  const chunks: Array<{ since: number; until: number }> = [];
  let cur = sinceUnix;
  while (cur < untilUnix) {
    const end = Math.min(cur + CHUNK_SECS, untilUnix);
    chunks.push({ since: cur, until: end });
    cur = end;
  }

  const allResults: SegregatedRevenueDay[] = [];

  for (const chunk of chunks) {
    const chunkResults = await fetchSegregatedRevenueChunk(
      profileId, accessToken, chunk.since, chunk.until,
    );
    allResults.push(...chunkResults);
  }

  // Deduplicate by date (overlapping chunk boundaries)
  const byDate = new Map<string, SegregatedRevenueDay>();
  for (const row of allResults) {
    byDate.set(row.date, row);
  }

  const deduped = Array.from(byDate.values());
  if (deduped.length > 0) {
    console.log(
      `[Meta API] Segregated revenue for ${profileId}: ${deduped.length} days across ${chunks.length} chunk(s)`,
    );
  }
  return deduped;
};

/**
 * Fetch a single ≤ 30-day chunk of segregated revenue.
 *
 * Per official Meta docs:
 *   - content_monetization_earnings → valid breakdown: "earning_source"
 *   - monetization_approximate_earnings → valid breakdown: "monetization_tool"
 *
 * Meta may return the breakdown in two shapes:
 *   A) Multiple top-level data entries (one per earning source), each with
 *      per-day values as { currency, microAmount } or numbers.
 *   B) A single data entry whose per-day values are objects with content-type
 *      keys (e.g. { "reels": {currency, microAmount}, "photos_text_stories": ... }).
 *
 * Priority:
 *   1. content_monetization_earnings + breakdown=earning_source  (shape A or B)
 *   2. monetization_approximate_earnings + breakdown=monetization_tool (shape A or B)
 *   3. content_monetization_earnings (no breakdown → total only)
 *   4. monetization_approximate_earnings (legacy total)
 */
async function fetchSegregatedRevenueChunk(
  profileId: string,
  accessToken: string,
  sinceUnix: number,
  untilUnix: number,
): Promise<SegregatedRevenueDay[]> {

  // Helper: a breakdown response is only "useful" if it actually segregates
  // revenue across at least one of photo/reel/story/text. If it's all dumped
  // into `total` with zero per-type buckets, the API returned an aggregate-only
  // response (wrong breakdown name, no permission, etc.) and we should try the
  // next attempt instead of returning a useless all-zeros breakdown.
  const isSegregated = (rows: SegregatedRevenueDay[]) =>
    rows.some((r) => r.photo > 0 || r.reel > 0 || r.story > 0 || r.text > 0);

  // --- Attempt 0.1: POST /{page_id}/content_monetization_earnings (direct edge) ---
  // Per Meta v23 docs, the only valid breakdown for content_monetization_earnings
  // at the page level is `earning_source` (NOT `content_type`).
  try {
    const url = `${BASE_URL}/${profileId}/content_monetization_earnings`;
    const response = await axios.post(url, null, {
      params: {
        since: sinceUnix,
        until: untilUnix,
        period: 'day',
        breakdown: 'earning_source',
        access_token: accessToken,
      }
    });
    const dataEntries = response.data?.data || (response.data ? [response.data] : []);
    if (dataEntries.length > 0) {
      const result = parseEarningSourceResponse(dataEntries);
      if (result.length > 0 && isSegregated(result)) {
         console.log(`[Meta API] Segregated breakdown parsed for ${profileId}: ${result.length} days (Attempt 0.1 POST)`);
         return result;
      }
    }
  } catch (err: any) {
    console.warn(`[Meta API] Attempt 0.1 (POST direct edge) failed for ${profileId}:`, err.response?.data?.error?.message || err.message);
  }

  // --- Attempt 0.2: GET /{page_id}/content_monetization_earnings (direct edge) ---
  try {
    const url = `${BASE_URL}/${profileId}/content_monetization_earnings` +
                `?since=${sinceUnix}&until=${untilUnix}&period=day&breakdown=earning_source&access_token=${accessToken}`;

    const response = await axios.get(url);
    const dataEntries = response.data?.data || (response.data ? [response.data] : []);
    if (dataEntries.length > 0) {
      const result = parseEarningSourceResponse(dataEntries);
      if (result.length > 0 && isSegregated(result)) {
         console.log(`[Meta API] Segregated breakdown parsed for ${profileId}: ${result.length} days (Attempt 0.2 GET)`);
         return result;
      }
    }
  } catch (err: any) {
    console.warn(`[Meta API] Attempt 0.2 (GET direct edge) failed for ${profileId}:`, err.response?.data?.error?.message || err.message);
  }

  // --- Attempt 1: insights?metric=content_monetization_earnings&breakdown=earning_source ---
  // Primary source for accurate segmentation. Meta returns each value with an
  // `earning_source` sibling field (Shape C):
  //   { value: 20.23, earning_source: "image", end_time: "..." }
  // OR multiple data entries (Shape A), one per earning_source.
  try {
    const url =
      `${BASE_URL}/${profileId}/insights` +
      `?metric=content_monetization_earnings` +
      `&period=day&since=${sinceUnix}&until=${untilUnix}` +
      `&breakdown=earning_source` +
      `&access_token=${accessToken}`;

    const response = await axios.get(url);
    const dataEntries = response.data?.data || [];

    if (dataEntries.length > 0) {
      if (dataEntries[0]?.values?.length > 0) {
        console.log(
          `[Meta API] content_monetization_earnings+earning_source: ${dataEntries.length} entries, sample: ${JSON.stringify(dataEntries[0].values[0]).slice(0, 400)}`,
        );
      }

      const result = parseEarningSourceResponse(dataEntries);
      if (result.length > 0 && isSegregated(result)) {
        console.log(
          `[Meta API] Segregated breakdown parsed for ${profileId}: ${result.length} days (Attempt 1)`,
        );
        return result;
      }
    }
  } catch (err: any) {
    console.warn(
      `[Meta API] Attempt 1 (content_monetization_earnings+earning_source) failed for ${profileId}:`,
      err.response?.data?.error?.message || err.message,
    );
  }

  // --- Attempt 2: monetization_approximate_earnings + breakdown=monetization_tool ---
  // This tends to return "content_monetization" as the tool (not content-type breakdown).
  // Less useful for segregation, but try it as fallback.
  try {
    const url =
      `${BASE_URL}/${profileId}/insights` +
      `?metric=monetization_approximate_earnings` +
      `&period=day&since=${sinceUnix}&until=${untilUnix}` +
      `&breakdown=monetization_tool` +
      `&access_token=${accessToken}`;

    const response = await axios.get(url);
    const dataEntries = response.data?.data || [];

    if (dataEntries.length > 0) {
      if (dataEntries[0]?.values?.length > 0) {
        console.log(
          `[Meta API] monetization_approximate_earnings+monetization_tool: ${dataEntries.length} entries, sample: ${JSON.stringify(dataEntries[0].values[0]).slice(0, 300)}`,
        );
      }

      // This metric returns monetization_tool (e.g. "content_monetization") not content type.
      // Only use it if the parse actually yielded per-type segregation —
      // otherwise fall through so Attempt 3 can return a clean total.
      const result = parseEarningSourceResponse(dataEntries);
      if (result.length > 0 && isSegregated(result)) return result;
    }
  } catch (err: any) {
    console.warn(
      `[Meta API] Attempt 2 (monetization_approximate_earnings+monetization_tool) failed for ${profileId}:`,
      err.response?.data?.error?.message || err.message,
    );
  }

  // --- Attempt 3: content_monetization_earnings (no breakdown) → total only ---
  try {
    const url =
      `${BASE_URL}/${profileId}/insights` +
      `?metric=content_monetization_earnings` +
      `&period=day&since=${sinceUnix}&until=${untilUnix}` +
      `&access_token=${accessToken}`;

    const response = await axios.get(url);
    const values = response.data?.data?.[0]?.values;

    if (values?.length) {
      console.log(
        `[Meta API] content_monetization_earnings (no breakdown) for ${profileId}: ${values.length} days, sample:`,
        JSON.stringify(values[0]?.value).slice(0, 200),
      );
      const parsed = parseSegregatedValues(values);
      if (parsed.length > 0) return parsed;
    }
  } catch (err: any) {
    console.warn(
      `[Meta API] Attempt 3 (content_monetization_earnings no breakdown) failed for ${profileId}:`,
      err.response?.data?.error?.message || err.message,
    );
  }

  // --- Fallback: monetization_approximate_earnings (legacy total) ---
  console.warn(
    `[Meta API] All segregated attempts failed for ${profileId}, using legacy total`,
  );
  const totalRevenue = await fetchDailyRevenue(profileId, accessToken, sinceUnix, untilUnix);
  // Legacy fallback: we only have a single aggregate per day with no breakdown.
  // Meta does not expose a bonus figure, so bonus MUST stay 0 — the unsegregated
  // lump sum lives in `total` only.
  return totalRevenue.map((rv) => ({
    date: rv.date,
    bonus: 0,
    photo: 0,
    reel: 0,
    story: 0,
    text: 0,
    total: rv.revenue,
  }));
}

/**
 * Parse Meta's earning_source / monetization_tool breakdown response.
 *
 * Handles all observed response shapes:
 *
 * Shape A — Multiple top-level data entries (one per earning source):
 *   data: [
 *     { title: "Reels", values: [{ value: 12.34, end_time }] },
 *     { title: "Bonus", values: [{ value: 5.67, end_time }] },
 *   ]
 *
 * Shape C — Single data entry where each value has an `earning_source`
 *   or `monetization_tool` sibling field:
 *   data: [{ values: [
 *     { value: 20.23, earning_source: "image", end_time: "..." },
 *     { value: 5.00,  earning_source: "reel",  end_time: "..." },
 *   ]}]
 *
 * In both shapes, we merge per-date into SegregatedRevenueDay records.
 */
function parseEarningSourceResponse(dataEntries: any[]): SegregatedRevenueDay[] {
  const dayMap = new Map<string, SegregatedRevenueDay>();

  for (const entry of dataEntries) {
    // Determine if it's a flat array of values or nested under .values
    const valuesArray = (entry.values && Array.isArray(entry.values)) ? entry.values : [entry];

    // Shape A: entry-level label (used when there are multiple entries)
    const entryLabel = (
      entry.title || entry.name || entry.description || entry.id || ''
    ).toLowerCase();

    for (const val of valuesArray) {
      if (val.value === undefined || (!val.end_time && !val.time && !val.date)) continue;
      
      const timeStr = val.end_time || val.time || val.date;
      const actualDate = new Date(timeStr);
      actualDate.setDate(actualDate.getDate() - 1);
      const dateStr = actualDate.toISOString().split('T')[0];
      const amount = toDollars(val.value);

      if (!dayMap.has(dateStr)) {
        dayMap.set(dateStr, {
          date: dateStr, bonus: 0, photo: 0, reel: 0, story: 0, text: 0, total: 0,
        });
      }
      const day = dayMap.get(dateStr)!;

      // Determine the content-type label.
      // Shape C: use `content_type`, `earning_source` or `monetization_tool` sibling field.
      // Shape A: use the entry-level title/name.
      const sourceLabel = (
        val.content_type || val.earning_source || val.monetization_tool || entryLabel || ''
      ).toLowerCase();

      // Map the label to one of our canonical buckets and always accumulate
      // into day.total — unclassified umbrellas (e.g. "content_monetization")
      // still count toward the true page total even if we can't split them.
      addAmountToBucket(day, sourceLabel, amount);
    }
  }

  return Array.from(dayMap.values());
}

/**
 * Map a Meta earning_source / monetization_tool label to one of our
 * 5 revenue buckets: bonus, photo, reel, story, text.
 *
 * Known `earning_source` values from Meta API:
 *   "image", "reel", "video", "text", "bonus", "story",
 *   "in_stream", "in-stream", "extra", "performance_bonus",
 *   "photos, text & stories", "content_monetization"
 */
function addAmountToBucket(day: SegregatedRevenueDay, label: string, amount: number) {
  if (amount === 0) return;

  // Every amount contributes to the page's total, even if we can't classify it.
  // Meta's umbrella labels (e.g. "content_monetization") and unknown labels
  // stay out of the per-type buckets but must still be counted in `total`.
  day.total += amount;

  if (label.includes('bonus') || label.includes('extra') || label.includes('performance'))
                                                          day.bonus += amount;
  else if (label === 'reel' || label.includes('reel'))    day.reel  += amount;
  else if (label.includes('video') || label.includes('in_stream') || label.includes('in-stream'))
                                                          day.reel  += amount;
  else if (label.includes('photos, text') || label.includes('photo, text')) {
    // Meta sometimes groups "Photos, text & stories" as one label.
    // Assign to photo as primary bucket.
    day.photo += amount;
  }
  else if (label === 'image' || label.includes('photo') || label.includes('image'))
                                                          day.photo += amount;
  else if (label.includes('story') || label.includes('stories'))
                                                          day.story += amount;
  else if (label === 'text' || label.includes('text') || label.includes('short_form'))
                                                          day.text  += amount;
  else if (label.includes('content_monetization')) {
    // monetization_tool="content_monetization" — this is the umbrella tool,
    // NOT a content type and NOT a bonus. Meta does not expose a bonus figure.
    // Leave it in `total` only; it's an unsegregated lump sum.
  }
  else {
    // Unknown label — keep in total only. Do NOT dump into bonus, because
    // Meta's API does not actually report a bonus figure.
    console.warn(`[Meta API] Unknown earning source "${label}" = $${amount.toFixed(4)} — counted in total only`);
  }
}

