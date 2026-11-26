// Adds connect_timeout=15 to the database link (unless one is set), so a
// sleeping Neon database has time to wake before Prisma gives up.
function withWakeTime(url) {
  if (!url || /[?&]connect_timeout=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'connect_timeout=15';
}

module.exports = { withWakeTime };
