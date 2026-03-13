import axios from 'axios';

const META_API_VERSION = 'v25.0';
const BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export const exchangeForLongLivedToken = async (shortLivedToken: string) => {
  const url = `${BASE_URL}/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${shortLivedToken}`;
  const response = await axios.get(url);
  return response.data.access_token;
};

export const fetchPermanentPageTokens = async (userId: string | 'me', accessToken: string) => {
  let url = `${BASE_URL}/${userId}/accounts?limit=100&access_token=${accessToken}`;
  const allPages: any[] = [];
  while (url) {
    try {
      const response = await axios.get(url);
      if (response.data.data) allPages.push(...response.data.data);
      url = response.data.paging?.next ? response.data.paging.next : null;
    } catch (error) { break; }
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
      console.warn(`[Meta API Warning] Could not fetch IG account for FB Page ${page.id}`);
    }
  }
  return igAccounts;
};

export const fetchProfileBasics = async (profileId: string, accessToken: string, platform: 'facebook' | 'instagram') => {
  try {
    const fields = platform === 'facebook' ? 'id,name,followers_count' : 'id,username,name,followers_count,profile_picture_url';
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
      const fbMetrics = 'page_impressions_unique,page_post_engagements,page_daily_follows_unique,page_daily_unfollows_unique,page_video_views,page_total_actions,page_views_total';
      const url = `${BASE_URL}/${profileId}/insights?metric=${fbMetrics}&period=day&since=${sinceUnix}&until=${untilUnix}&access_token=${accessToken}`;
      const response = await axios.get(url);
      if (response.data?.data) aggregatedData = [...aggregatedData, ...response.data.data];
    } catch (err: any) {
      console.warn(`[Meta API Warning] Main FB metrics failed for ${profileId}:`, err.response?.data?.error?.message || err.message);
    }

    try {
      const msgUrl = `${BASE_URL}/${profileId}/insights?metric=page_messages_new_conversations_unique,page_messages_total_messaging_connections&period=day&since=${sinceUnix}&until=${untilUnix}&access_token=${accessToken}`;
      const msgRes = await axios.get(msgUrl);
      if (msgRes.data?.data) aggregatedData = [...aggregatedData, ...msgRes.data.data];
    } catch (msgError: any) { }

  } else if (platform === 'instagram') {
    const totalValueMetrics = ['views', 'profile_views', 'website_clicks', 'total_interactions', 'follows_and_unfollows'];
    const url1 = `${BASE_URL}/${profileId}/insights?metric=${totalValueMetrics.join(',')}&period=day&metric_type=total_value&since=${sinceUnix}&until=${untilUnix}&access_token=${accessToken}`;
    
    try {
      const res1 = await axios.get(url1);
      if (res1.data.data) aggregatedData = [...aggregatedData, ...res1.data.data];
    } catch (err: any) {
      console.warn(`[Meta API Warning] IG total_value metrics failed for ${profileId}:`, err.response?.data?.error?.message || err.message);
    }

    const standardMetrics = ['reach'];
    const thirtyDaysAgoUnix = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
    if (sinceUnix >= thirtyDaysAgoUnix) {
      standardMetrics.push('follower_count');
    }

    const url2 = `${BASE_URL}/${profileId}/insights?metric=${standardMetrics.join(',')}&period=day&since=${sinceUnix}&until=${untilUnix}&access_token=${accessToken}`;
    
    try {
      const res2 = await axios.get(url2);
      if (res2.data.data) aggregatedData = [...aggregatedData, ...res2.data.data];
    } catch (err: any) {
       console.warn(`[Meta API Warning] IG standard metrics failed for ${profileId}:`, err.response?.data?.error?.message || err.message);
    }
  }
  
  return aggregatedData;
};

export async function fetchPostsPaginated(
  profileId: string, 
  accessToken: string, 
  platform: 'facebook' | 'instagram', 
  since: Date, 
  until: Date
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

    const fetchWithFallback = async (currentUrl: string, currentEdge: string): Promise<any> => {
      let response = await fetch(currentUrl);
      let data = await response.json();
      
      if (data.error) {
        if (currentEdge === 'promotable_posts' && data.error.code === 100) {
          console.warn(`[Meta API Warning] ${profileId} lacks Ad Account/Permissions. Falling back to published_posts...`);
          const fallbackUrl = currentUrl.replace('/promotable_posts?', '/published_posts?');
          response = await fetch(fallbackUrl);
          data = await response.json();
        }
        
        if (data.error && data.error.message?.includes("reduce the amount of data")) {
          console.warn(`[Meta API Warning] Payload too large for ${profileId}. Dynamically reducing limit to 10...`);
          const reducedUrl = currentUrl.replace(`limit=${initialLimit}`, `limit=10`);
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
  postType: string
) => {
  try {
    if (platform === 'facebook') {
      const metrics = postType === 'video' ? 'post_impressions_unique,post_video_views,post_clicks' : 'post_impressions_unique,post_clicks';
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
    console.warn(`[Meta API Warning] Failed to fetch post insights for ${postId}:`, error.response?.data?.error?.message || error.message);
    return [];
  }
};

export const fetchDemographics = async (
  profileId: string,
  accessToken: string,
  platform: 'facebook' | 'instagram'
) => {
  try {
    if (platform === 'facebook') {
      const metrics = 'page_fans_gender_age,page_fans_country,page_fans_city';
      const url = `${BASE_URL}/${profileId}/insights?metric=${metrics}&period=lifetime&access_token=${accessToken}`;
      const response = await axios.get(url);
      return response.data.data || [];
    } else if (platform === 'instagram') {
      const metrics = 'follower_demographics';
      const breakdowns = ['age', 'gender', 'country', 'city'];
      const results: any[] = [];
      
      for (const b of breakdowns) {
         const url = `${BASE_URL}/${profileId}/insights?metric=${metrics}&period=lifetime&timeframe=last_30_days&breakdown=${b}&access_token=${accessToken}`;
         try {
           const response = await axios.get(url);
           if (response.data.data) results.push(...response.data.data);
         } catch (e: any) {}
      }
      return results;
    }
    return [];
  } catch (error: any) {
    return [];
  }
};