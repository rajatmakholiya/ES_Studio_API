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
  const allPages:any[] = [];
  while (url) {
    try {
      const response = await axios.get(url);
      if (response.data.data) allPages.push(...response.data.data);
      url = response.data.paging?.next ? response.data.paging.next : null;
    } catch (error) { break; }
  }
  return allPages;
};

export const fetchProfileBasics = async (profileId: string, accessToken: string, platform: 'facebook' | 'instagram') => {
  try {
    const fields = platform === 'facebook' ? 'name,followers_count,picture' : 'username,name,followers_count,profile_picture_url';
    const url = `${BASE_URL}/${profileId}?fields=${fields}&access_token=${accessToken}`;
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    return { name: 'Unknown Page', followers_count: 0 };
  }
};

export const fetchDailySnapshot = async (profileId: string, accessToken: string, platform: 'facebook' | 'instagram', sinceUnix?: number, untilUnix?: number) => {
  let aggregatedData: any[] = [];
  
  if (platform === 'facebook') {
    try {
      const fbMetrics = 'page_impressions_unique,page_post_engagements,page_daily_follows_unique,page_daily_unfollows_unique,page_total_actions,page_views_total,page_video_views';
      let url = `${BASE_URL}/${profileId}/insights?metric=${fbMetrics}&period=day&access_token=${accessToken}`;
      if (sinceUnix && untilUnix) url += `&since=${sinceUnix}&until=${untilUnix}`;
      
      const response = await axios.get(url);
      if (response.data?.data) {
        aggregatedData = [...aggregatedData, ...response.data.data];
      }
    } catch (err: any) {
      console.warn(`[Meta API Warning] Main FB metrics failed for ${profileId}`);
    }

    try {
      let msgUrl = `${BASE_URL}/${profileId}/insights?metric=page_messages_new_conversations_unique,page_messages_total_messaging_connections&period=day&access_token=${accessToken}`;
      if (sinceUnix && untilUnix) msgUrl += `&since=${sinceUnix}&until=${untilUnix}`;
      const msgRes = await axios.get(msgUrl);
      if (msgRes.data?.data) aggregatedData = [...aggregatedData, ...msgRes.data.data];
    } catch (msgError: any) { }
  } else {
    try {
      const igMetrics = 'impressions,reach,profile_views,follower_count,website_clicks';
      let url = `${BASE_URL}/${profileId}/insights?metric=${igMetrics}&period=day&access_token=${accessToken}`;
      if (sinceUnix && untilUnix) url += `&since=${sinceUnix}&until=${untilUnix}`;
      const response = await axios.get(url);
      if (response.data?.data) {
        aggregatedData = [...aggregatedData, ...response.data.data];
      }
    } catch (err: any) {
      console.warn(`[Meta API Warning] Skipping IG metrics for ${profileId}`);
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
    
    let url = `https://graph.facebook.com/v25.0/${profileId}/${edge}?access_token=${accessToken}&since=${sinceUnix}&until=${untilUnix}&limit=${initialLimit}`;
    
    if (platform === 'facebook') {
      url += `&fields=id,created_time,message,status_type,is_published,is_eligible_for_promotion,from,permalink_url,full_picture,picture,attachments{media_type,media,url,type},likes.summary(true),comments.summary(true),shares`;
    } else {
      url += `&fields=id,timestamp,caption,media_type,media_url,thumbnail_url,permalink,like_count,comments_count,owner`;
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

export const fetchPostDeepInsights = async (postId: string, accessToken: string, platform: 'facebook' | 'instagram', postType: string) => {
  try {
    let metrics = '';
    if (platform === 'facebook') {
      if (postType === 'story') {
         metrics = 'post_impressions_unique';
      } else {
         metrics = 'post_impressions_unique,post_clicks'; 
         if (postType === 'video' || postType === 'added_video' || postType === 'video_inline' || postType === 'REELS') {
           metrics += ',post_video_views'; 
         }
      }
    } else {
      if (postType === 'story') {
        metrics = 'impressions,reach,replies'; 
      } else {
        metrics = 'plays,reach,saved';
      }
    }
    const url = `${BASE_URL}/${postId}/insights?metric=${metrics}&access_token=${accessToken}`;
    const response = await axios.get(url);
    return response.data.data;
  } catch (error) {
    return [];
  }
};