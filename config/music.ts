/**
 * @file music.ts
 * @description Music playback configuration for the native Lavende engine.
 */

const musicConfig = {
  defaultVolume:       100,
  autoLeaveMs:         30_000,
  /**
   * Default search prefix when no URL or explicit source prefix is provided.
   * 'scsearch:' = SoundCloud — more reliable from server IPs than YouTube.
   * Users can still force YouTube with 'yt:their query' or a direct URL.
   */
  defaultSearchPrefix: 'scsearch:',
};

export default musicConfig;
