// Reads that include Customer.isTestAccount keep working if the column
// hasn't been added to the database yet (before `npm run prisma:push`):
// on "column does not exist" the read is retried without it.
const missingColumn = (e) => Boolean(e) && (e.code === 'P2022' || /isTestAccount/.test(String(e.message || '')));

async function withFlag(read, select) {
  try {
    return await read({ ...select, isTestAccount: true });
  } catch (error) {
    if (!missingColumn(error)) throw error;
    return read(select);
  }
}

module.exports = { withFlag, missingColumn };
