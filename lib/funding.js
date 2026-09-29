// Business accounts customers can pay into for manual funding. Falls
// back to the old single-account fields for settings saved before the
// list existed.
function allManualAccounts(settings) {
  const list = Array.isArray(settings.manualAccounts) ? settings.manualAccounts : [];
  if (list.length) return list;
  if (settings.manualAccountNumber) {
    return [{ id: 'main', bankName: settings.manualBankName || '', accountNumber: settings.manualAccountNumber, accountName: settings.manualAccountName || '', enabled: true }];
  }
  return [];
}

function activeManualAccounts(settings) {
  if (!settings.manualFundingEnabled) return [];
  return allManualAccounts(settings).filter((a) => a.enabled !== false && a.accountNumber);
}

function hiddenBanks(settings) {
  return (Array.isArray(settings.hiddenFundingBanks) ? settings.hiddenFundingBanks : []).map((b) => String(b).toLowerCase());
}

// Customer's automatic (Monnify) accounts minus banks the admin has
// switched off for now.
function visibleReservedAccounts(accounts, settings) {
  if (!Array.isArray(accounts)) return accounts;
  const hidden = hiddenBanks(settings);
  return accounts.filter((a) => !hidden.includes(String(a.bankName || '').toLowerCase()));
}

module.exports = { allManualAccounts, activeManualAccounts, visibleReservedAccounts, hiddenBanks };
