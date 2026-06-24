// Shared size thresholds, kept in one place so validation and the streaming
// writer never disagree. MAX_PIXEL_BYTES (512 MB) is the in-memory pixel cap
// that guards against OOM; MAX_STREAM_BYTES (50 GB) is the disk-only streaming
// ceiling for a single large-image file.
export const MAX_PIXEL_BYTES = 512 * 1024 * 1024
export const MAX_STREAM_BYTES = 50 * 1024 * 1024 * 1024
