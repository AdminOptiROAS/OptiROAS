// Plain-language causes and recovery steps for platform API errors, so owners never see raw API messages.
const RULES = {
  google: [
    [/invalid_grant|expired|revoked/i, 'Your Google connection has expired or was removed.', 'Reconnect Google Ads from My account.'],
    [/USER_PERMISSION_DENIED|PERMISSION_DENIED|doesn't have permission|not have access/i, 'The Google login you connected can’t read this account.', 'Ask the account owner to add that Google login to the ad account (Admin → Access and security), or connect with a login that already has access.'],
    [/CUSTOMER_NOT_ENABLED|not enabled|CANCELED|cancelled/i, 'This Google Ads account isn’t active (it may be cancelled or never finished setup).', 'Choose another account, or reactivate it in Google Ads.'],
    [/DEVELOPER_TOKEN|developer token/i, 'Google hasn’t approved OptiROAS for this kind of account yet.', 'Upload a Google Ads export for now; we’re finishing Google’s approval.'],
    [/MANAGER|manager account|login-customer-id|login_customer_id/i, 'This is a manager (MCC) account or needs its manager to be selected.', 'Pick the individual client account under the manager account.'],
    [/RESOURCE_EXHAUSTED|quota|rate/i, 'Google is limiting requests right now.', 'Try again in a few minutes.'],
    [/./, 'Google Ads didn’t return the data.', 'Try again in a few minutes, or upload a Google Ads export instead.']],
  meta: [
    [/\b190\b|OAuthException|expired|session/i, 'Your Meta connection has expired.', 'Reconnect Meta from My account.'],
    [/\b(10|200|294)\b|permission|not authorized|ads_read/i, 'The Meta login you connected can’t read this ad account.', 'Reconnect Meta and tick this ad account, or ask its owner to give your login access in Business settings.'],
    [/\b(4|17|32|613|80004)\b|too many|rate limit|request limit/i, 'Meta is limiting requests for this account right now.', 'Try again in about 15 minutes.'],
    [/network|reach Meta/i, 'Meta couldn’t be reached.', 'Check your connection and try again.'],
    [/./, 'Meta didn’t return the data.', 'Try again in a few minutes, or upload a Meta Ads export instead.']],
  snap: [
    [/401|invalid_grant|expired/i, 'Your Snapchat connection has expired.', 'Reconnect Snapchat from My account.'],
    [/403|permission/i, 'The Snapchat login you connected can’t read this ad account.', 'Ask the account admin to add your login as a member of the ad account.'],
    [/./, 'Snapchat didn’t return the data.', 'Try again in a few minutes, or upload a Snapchat export instead.']],
  tiktok: [
    [/40105|40104|401|expired/i, 'Your TikTok connection has expired.', 'Reconnect TikTok from My account.'],
    [/40001|permission|scope/i, 'The TikTok login you connected can’t read this advertiser account.', 'Reconnect and tick this advertiser account.'],
    [/./, 'TikTok didn’t return the data.', 'Try again in a few minutes, or upload a TikTok export instead.']]
};
export function friendly(platform, msg) {
  const m = String(msg || ''), r = (RULES[platform] || RULES.google).find(([re]) => re.test(m));
  return { cause: r[1], fix: r[2], text: `${r[1]} ${r[2]}` };
}
