import { useEffect, useState } from 'react';
import PasswordField from '../../components/PasswordField';
import AdminLayout from '../../components/AdminLayout';
import { getSettings, updateSettings, changeAdminPassword, testMonnifyConnection, getMonnifyOverview, resetMonnifyAccounts, sendTestDailySummary } from '../../api';

const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNET', 'BETTING'];

// Each tab is its own form with its own Save button, and only sends
// the fields that belong to it — PATCH /admin/settings already
// accepts partial updates, so saving discounts can never overwrite
// the VTpass keys (or vice versa) with stale values from another tab.
const TABS = [
  { key: 'vtpass', label: 'VTpass' },
  { key: 'monnify', label: 'Monnify' },
  { key: 'markup', label: 'Markup' },
  { key: 'discount', label: 'Discounts' },
  { key: 'limits', label: 'Limits' },
  { key: 'airtimeCash', label: 'Airtime to Cash' },
  { key: 'referral', label: 'Referrals' },
  { key: 'cashback', label: 'Cashback' },
  { key: 'agents', label: 'Agents' },
  { key: 'loyalty', label: 'Loyalty Points' },
  { key: 'alerts', label: 'Alerts & Limits' },
  { key: 'security', label: 'Security' },
  { key: 'password', label: 'My Password' },
];

const A2C_NETWORKS = [
  { key: 'mtn', label: 'MTN' },
  { key: 'glo', label: 'Glo' },
  { key: 'airtel', label: 'Airtel' },
  { key: 'etisalat', label: '9mobile' },
];

function serviceLabel(s) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function toServiceMap(stored) {
  return Object.fromEntries(SERVICES.map((svc) => [svc, String(stored?.[svc] ?? 0)]));
}

function toNumberMap(values) {
  return Object.fromEntries(SERVICES.map((svc) => [svc, Number(values[svc] || 0)]));
}

function Status({ state }) {
  if (state?.error) return <p className="error-text" style={{ margin: '0 0 12px' }}>{state.error}</p>;
  if (state?.success) return <p style={{ color: 'var(--green-500)', fontSize: 14, margin: '0 0 12px' }}>{state.success}</p>;
  return null;
}

function SectionHeader({ title, hint }) {
  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: 16, marginBottom: 4 }}>{title}</h2>
      {hint && <p style={{ color: 'var(--slate-400)', fontSize: 13, marginTop: 0, marginBottom: 12 }}>{hint}</p>}
    </>
  );
}

export default function AdminSettings() {
  const [tab, setTab] = useState('vtpass');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [vtpassMode, setVtpassMode] = useState('sandbox');
  const [vtpassApiKey, setVtpassApiKey] = useState('');
  const [vtpassSecretKey, setVtpassSecretKey] = useState('');
  const [vtpassPublicKey, setVtpassPublicKey] = useState('');
  const [markupByService, setMarkupByService] = useState(toServiceMap({}));
  const [discountByService, setDiscountByService] = useState(toServiceMap({}));
  const [monnifyMode, setMonnifyMode] = useState('sandbox');
  const [monnifyApiKey, setMonnifyApiKey] = useState('');
  const [monnifySecretKey, setMonnifySecretKey] = useState('');
  const [monnifyContractCode, setMonnifyContractCode] = useState('');
  const [monnifyTest, setMonnifyTest] = useState(null);
  const [resetText, setResetText] = useState('');
  const [resetState, setResetState] = useState(null);
  const [accountsCount, setAccountsCount] = useState(null);
  const [walletAccount, setWalletAccount] = useState('');
  const [btEnabled, setBtEnabled] = useState(false);
  const [btFee, setBtFee] = useState('0');
  const [btMin, setBtMin] = useState('100');
  const [btMax, setBtMax] = useState('50000');
  const [btDaily, setBtDaily] = useState('200000');
  const [minFundingAmount, setMinFundingAmount] = useState('100');
  const [minPurchaseAmount, setMinPurchaseAmount] = useState('50');
  const [bankFeePercent, setBankFeePercent] = useState('0');
  const [bankFeeCap, setBankFeeCap] = useState('0');

  const [a2cEnabled, setA2cEnabled] = useState(false);
  const [a2cFee, setA2cFee] = useState('20');
  const [a2cMin, setA2cMin] = useState('500');
  const [a2cNumbers, setA2cNumbers] = useState({});

  const [loyOn, setLoyOn] = useState(false);
  const [loyPer100, setLoyPer100] = useState('1');
  const [loyValue, setLoyValue] = useState('0.5');
  const [loyMin, setLoyMin] = useState('200');
  const [fraudOn, setFraudOn] = useState(true);
  const [fraudAmount, setFraudAmount] = useState('20000');
  const [fraudHours, setFraudHours] = useState('24');
  const [twoFactor, setTwoFactor] = useState(false);
  const [summaryOn, setSummaryOn] = useState(false);
  const [summaryTest, setSummaryTest] = useState(null);
  const [agentOn, setAgentOn] = useState(false);
  const [agentByService, setAgentByService] = useState(toServiceMap({}));
  const [cbEnabled, setCbEnabled] = useState(false);
  const [cbByService, setCbByService] = useState(toServiceMap({}));
  const [cbMax, setCbMax] = useState('500');
  const [alertsOn, setAlertsOn] = useState(false);
  const [limitsOn, setLimitsOn] = useState(false);
  const [limitUnverified, setLimitUnverified] = useState('50000');
  const [limitVerified, setLimitVerified] = useState('1000000');
  const [whatsapp, setWhatsapp] = useState('');
  const [manualOn, setManualOn] = useState(true);
  const [manualBank, setManualBank] = useState('');
  const [manualNumber, setManualNumber] = useState('');
  const [manualName, setManualName] = useState('');
  const [refEnabled, setRefEnabled] = useState(false);
  const [refBonus, setRefBonus] = useState('100');
  const [refMin, setRefMin] = useState('500');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // One saving flag + status message per tab, so a success message on
  // one tab doesn't linger when you switch to another.
  const [saving, setSaving] = useState('');
  const [status, setStatus] = useState({});

  useEffect(() => {
    getSettings()
      .then((data) => {
        const s = data.settings;
        setVtpassMode(s.vtpassMode);
        setVtpassApiKey(s.vtpassApiKey || '');
        setVtpassSecretKey(s.vtpassSecretKey || '');
        setVtpassPublicKey(s.vtpassPublicKey || '');
        setMarkupByService(toServiceMap(s.markupPercentByService));
        setDiscountByService(toServiceMap(s.discountPercentByService));
        setMonnifyMode(s.monnifyMode || 'sandbox');
        setMonnifyApiKey(s.monnifyApiKey || '');
        setMonnifySecretKey(s.monnifySecretKey || '');
        setMonnifyContractCode(s.monnifyContractCode || '');
        setWalletAccount(s.monnifyWalletAccount || '');
        setBtEnabled(Boolean(s.bankTransferEnabled));
        setBtFee(String(s.bankTransferFee ?? 0));
        setBtMin(String(s.bankTransferMin ?? 100));
        setBtMax(String(s.bankTransferMax ?? 50000));
        setBtDaily(String(s.bankTransferDailyMax ?? 200000));
        setMinFundingAmount(String(s.minFundingAmount ?? 100));
        setMinPurchaseAmount(String(s.minPurchaseAmount ?? 50));
        setBankFeePercent(String(s.bankFundingFeePercent ?? 0));
        setBankFeeCap(String(s.bankFundingFeeCap ?? 0));
        setA2cEnabled(Boolean(s.airtimeToCashEnabled));
        setA2cFee(String(s.airtimeToCashFeePercent ?? 20));
        setA2cMin(String(s.airtimeToCashMinAmount ?? 500));
        setA2cNumbers(s.airtimeToCashNumbers || {});
        setLoyOn(Boolean(s.loyaltyEnabled));
        setLoyPer100(String(s.loyaltyPointsPer100 ?? 1));
        setLoyValue(String(s.loyaltyPointValue ?? 0.5));
        setLoyMin(String(s.loyaltyMinRedeem ?? 200));
        setFraudOn(s.fraudHoldEnabled !== false);
        setFraudAmount(String(s.fraudHoldAmount ?? 20000));
        setFraudHours(String(s.fraudHoldHours ?? 24));
        setTwoFactor(Boolean(s.adminTwoFactorEnabled));
        setSummaryOn(Boolean(s.dailySummaryEnabled));
        setAgentOn(Boolean(s.agentPricingEnabled));
        setAgentByService(toServiceMap(s.agentDiscountPercentByService));
        setCbEnabled(Boolean(s.cashbackEnabled));
        setCbByService(toServiceMap(s.cashbackPercentByService));
        setCbMax(String(s.cashbackMaxPerOrder ?? 500));
        setAlertsOn(Boolean(s.emailAlertsEnabled));
        setLimitsOn(Boolean(s.kycLimitsEnabled));
        setLimitUnverified(String(s.dailyLimitUnverified ?? 50000));
        setLimitVerified(String(s.dailyLimitVerified ?? 1000000));
        setWhatsapp(s.supportWhatsapp || '');
        setManualOn(s.manualFundingEnabled !== false);
        setManualBank(s.manualBankName || '');
        setManualNumber(s.manualAccountNumber || '');
        setManualName(s.manualAccountName || '');
        setRefEnabled(Boolean(s.referralEnabled));
        setRefBonus(String(s.referralBonusAmount ?? 100));
        setRefMin(String(s.referralMinPurchase ?? 500));
      })
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function save(key, payload, successText) {
    setStatus((prev) => ({ ...prev, [key]: null }));
    setSaving(key);
    try {
      await updateSettings(payload);
      setStatus((prev) => ({ ...prev, [key]: { success: successText } }));
    } catch (err) {
      setStatus((prev) => ({ ...prev, [key]: { error: err.message || 'Could not save.' } }));
    } finally {
      setSaving('');
    }
  }

  function saveVtpass(e) {
    e.preventDefault();
    save('vtpass', { vtpassMode, vtpassApiKey, vtpassSecretKey, vtpassPublicKey }, 'VTpass settings saved.');
  }

  function saveMonnify(e) {
    e.preventDefault();
    setMonnifyTest(null);
    save('monnify', { monnifyMode, monnifyApiKey, monnifySecretKey, monnifyContractCode }, 'Monnify settings saved. Tap "Test connection" to check them.');
  }

  useEffect(() => {
    if (tab === 'monnify') getMonnifyOverview().then((o) => setAccountsCount(o.accountsCount ?? 0)).catch(() => {});
  }, [tab]);

  async function runReset() {
    setResetState({ running: true });
    try {
      const r = await resetMonnifyAccounts();
      setResetState({ success: `Cleared ${r.cleared} customer account number${r.cleared === 1 ? '' : 's'}. Customers will get new ones the next time they open Wallet.` });
      setResetText('');
      setAccountsCount(0);
    } catch (err) {
      setResetState({ error: err.message });
    }
  }

  function saveBankTransfers(e) {
    e.preventDefault();
    if (btEnabled && !walletAccount.trim()) {
      setStatus((prev) => ({ ...prev, bankTransfers: { error: 'Enter your Monnify wallet account number before turning this on.' } }));
      return;
    }
    save(
      'bankTransfers',
      {
        monnifyWalletAccount: walletAccount,
        bankTransferEnabled: btEnabled,
        bankTransferFee: Number(btFee || 0),
        bankTransferMin: Number(btMin || 0),
        bankTransferMax: Number(btMax || 0),
        bankTransferDailyMax: Number(btDaily || 0),
      },
      btEnabled ? 'Saved — customers can now send to banks.' : 'Saved. Send to Bank is off for customers.'
    );
  }

  async function runMonnifyTest() {
    setMonnifyTest({ running: true });
    try {
      setMonnifyTest(await testMonnifyConnection());
    } catch (err) {
      setMonnifyTest({ ok: false, error: err.message });
    }
  }

  function saveMarkup(e) {
    e.preventDefault();
    save('markup', { markupPercentByService: toNumberMap(markupByService) }, 'Markup saved.');
  }

  function saveDiscount(e) {
    e.preventDefault();
    const bad = SERVICES.find((svc) => {
      const n = Number(discountByService[svc] || 0);
      return !Number.isFinite(n) || n < 0 || n > 100;
    });
    if (bad) {
      setStatus((prev) => ({ ...prev, discount: { error: `Discount for ${serviceLabel(bad)} must be between 0 and 100.` } }));
      return;
    }
    save('discount', { discountPercentByService: toNumberMap(discountByService) }, 'Discounts saved — live for customers now.');
  }

  function saveLimits(e) {
    e.preventDefault();
    if (manualOn && manualNumber && manualNumber.replace(/\D/g, '').length !== 10) {
      setStatus((prev) => ({ ...prev, limits: { error: 'Account number must be 10 digits.' } }));
      return;
    }
    save(
      'limits',
      {
        manualFundingEnabled: manualOn,
        manualBankName: manualBank,
        manualAccountNumber: manualNumber,
        manualAccountName: manualName,
        minFundingAmount: Number(minFundingAmount || 0),
        minPurchaseAmount: Number(minPurchaseAmount || 0),
        bankFundingFeePercent: Number(bankFeePercent || 0),
        bankFundingFeeCap: Number(bankFeeCap || 0),
      },
      'Limits saved.'
    );
  }

  function saveAirtimeCash(e) {
    e.preventDefault();
    const fee = Number(a2cFee || 0);
    if (!Number.isFinite(fee) || fee < 0 || fee >= 100) {
      setStatus((prev) => ({ ...prev, airtimeCash: { error: 'Fee must be at least 0 and below 100.' } }));
      return;
    }
    const hasNumber = A2C_NETWORKS.some((n) => String(a2cNumbers[n.key] || '').trim());
    if (a2cEnabled && !hasNumber) {
      setStatus((prev) => ({ ...prev, airtimeCash: { error: 'Add at least one receiving number before turning this on.' } }));
      return;
    }
    save(
      'airtimeCash',
      {
        airtimeToCashEnabled: a2cEnabled,
        airtimeToCashFeePercent: fee,
        airtimeToCashMinAmount: Number(a2cMin || 0),
        airtimeToCashNumbers: Object.fromEntries(A2C_NETWORKS.map((n) => [n.key, String(a2cNumbers[n.key] || '').trim()])),
      },
      'Airtime to Cash settings saved.'
    );
  }

  function saveLoyalty(e) {
    e.preventDefault();
    save('loyalty', { loyaltyEnabled: loyOn, loyaltyPointsPer100: Number(loyPer100 || 0), loyaltyPointValue: Number(loyValue || 0), loyaltyMinRedeem: Number(loyMin || 1) }, 'Loyalty settings saved.');
  }

  function saveSecurity(e) {
    e.preventDefault();
    save(
      'security',
      {
        fraudHoldEnabled: fraudOn,
        fraudHoldAmount: Number(fraudAmount || 0),
        fraudHoldHours: Number(fraudHours || 24),
        adminTwoFactorEnabled: twoFactor,
        dailySummaryEnabled: summaryOn,
      },
      'Security settings saved.'
    );
  }

  async function runSummaryTest() {
    setSummaryTest({ running: true });
    try {
      const r = await sendTestDailySummary();
      setSummaryTest({ ok: r.sent > 0, text: r.sent > 0 ? `Sent to ${r.sent} admin email${r.sent === 1 ? '' : 's'}.` : 'No email was sent — check your Resend setup.' });
    } catch (err) {
      setSummaryTest({ ok: false, text: err.message });
    }
  }

  function saveAgents(e) {
    e.preventDefault();
    const bad = SERVICES.find((svc) => { const n = Number(agentByService[svc] || 0); return !Number.isFinite(n) || n < 0 || n > 50; });
    if (bad) {
      setStatus((prev) => ({ ...prev, agents: { error: `Agent discount for ${serviceLabel(bad)} must be between 0 and 50%.` } }));
      return;
    }
    save('agents', { agentPricingEnabled: agentOn, agentDiscountPercentByService: toNumberMap(agentByService) }, 'Agent pricing saved.');
  }

  function saveCashback(e) {
    e.preventDefault();
    const bad = SERVICES.find((svc) => { const n = Number(cbByService[svc] || 0); return !Number.isFinite(n) || n < 0 || n > 20; });
    if (bad) {
      setStatus((prev) => ({ ...prev, cashback: { error: `Cashback for ${serviceLabel(bad)} must be between 0 and 20%.` } }));
      return;
    }
    save('cashback', { cashbackEnabled: cbEnabled, cashbackPercentByService: toNumberMap(cbByService), cashbackMaxPerOrder: Number(cbMax || 0) }, 'Cashback settings saved.');
  }

  function saveAlerts(e) {
    e.preventDefault();
    save(
      'alerts',
      {
        emailAlertsEnabled: alertsOn,
        kycLimitsEnabled: limitsOn,
        dailyLimitUnverified: Number(limitUnverified || 0),
        dailyLimitVerified: Number(limitVerified || 0),
        supportWhatsapp: whatsapp,
      },
      'Saved.'
    );
  }

  function saveReferral(e) {
    e.preventDefault();
    const bonus = Number(refBonus);
    const min = Number(refMin);
    if (!Number.isFinite(bonus) || bonus < 0 || !Number.isFinite(min) || min < 0) {
      setStatus((prev) => ({ ...prev, referral: { error: 'Amounts must be 0 or more.' } }));
      return;
    }
    if (refEnabled && bonus <= 0) {
      setStatus((prev) => ({ ...prev, referral: { error: 'Set a bonus above ₦0 before turning referrals on.' } }));
      return;
    }
    save('referral', { referralEnabled: refEnabled, referralBonusAmount: bonus, referralMinPurchase: min }, 'Referral settings saved.');
  }

  async function savePassword(e) {
    e.preventDefault();
    setStatus((prev) => ({ ...prev, password: null }));
    setSaving('password');
    try {
      await changeAdminPassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setStatus((prev) => ({ ...prev, password: { success: 'Password changed.' } }));
    } catch (err) {
      setStatus((prev) => ({ ...prev, password: { error: err.message || 'Could not change password.' } }));
    } finally {
      setSaving('');
    }
  }

  function saveButton(key, label) {
    return (
      <button className="btn" type="submit" disabled={saving === key}>
        {saving === key ? 'Saving…' : label}
      </button>
    );
  }

  const cardStyle = { margin: 0, maxWidth: 480 };

  return (
    <AdminLayout>
      <div className="page-header" style={{ padding: 0, marginBottom: 16 }}>
        <h1>Settings</h1>
        <p>Pick a section — each one saves on its own</p>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={t.key === tab ? 'btn' : 'btn-secondary btn'}
            style={{ width: 'auto', padding: '6px 14px', fontSize: 13 }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && tab !== 'password' && <p className="empty-state">Loading…</p>}
      {!loading && loadError && tab !== 'password' && (
        <p className="error-text" style={{ margin: '0 0 12px' }}>{loadError}</p>
      )}

      {!loading && !loadError && tab === 'vtpass' && (
        <form className="card" style={cardStyle} onSubmit={saveVtpass}>
          <SectionHeader title="VTpass Connection" hint="Mode and API keys used for every purchase." />
          <Status state={status.vtpass} />
          <div className="field">
            <label htmlFor="mode">VTpass mode</label>
            <select id="mode" value={vtpassMode} onChange={(e) => setVtpassMode(e.target.value)}>
              <option value="sandbox">Sandbox (test)</option>
              <option value="live">Live</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="apiKey">API key</label>
            <PasswordField id="apiKey" value={vtpassApiKey} onChange={(e) => setVtpassApiKey(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="secretKey">Secret key</label>
            <PasswordField id="secretKey" value={vtpassSecretKey} onChange={(e) => setVtpassSecretKey(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="publicKey">Public key</label>
            <PasswordField id="publicKey" value={vtpassPublicKey} onChange={(e) => setVtpassPublicKey(e.target.value)} />
          </div>
          {saveButton('vtpass', 'Save VTpass Settings')}
        </form>
      )}

      {!loading && !loadError && tab === 'monnify' && (
        <form className="card" style={cardStyle} onSubmit={saveMonnify}>
          <SectionHeader
            title="Monnify Connection"
            hint="Keys for customers' personal account numbers (automatic bank-transfer funding). Copy them from Monnify → Developer → API Keys & Contracts. Save first, then Test connection."
          />
          <Status state={status.monnify} />
          <div className="field">
            <label htmlFor="monnifyMode">Monnify mode</label>
            <select id="monnifyMode" value={monnifyMode} onChange={(e) => setMonnifyMode(e.target.value)}>
              <option value="sandbox">Sandbox (test) — keys start with MK_TEST_</option>
              <option value="live">Live — keys start with MK_PROD_</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="monnifyApiKey">API key</label>
            <PasswordField id="monnifyApiKey" value={monnifyApiKey} onChange={(e) => setMonnifyApiKey(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="monnifySecretKey">Secret key</label>
            <PasswordField id="monnifySecretKey" value={monnifySecretKey} onChange={(e) => setMonnifySecretKey(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="monnifyContractCode">Contract code</label>
            <input id="monnifyContractCode" value={monnifyContractCode} onChange={(e) => setMonnifyContractCode(e.target.value)} />
          </div>
          <p style={{ color: 'var(--slate-400)', fontSize: 12, marginTop: 0 }}>
            Webhook URL to set in Monnify (Transaction completion): https://zappi-pay-backend.onrender.com/api/webhooks/monnify
          </p>
          {monnifyTest && !monnifyTest.running && (
            <div style={{ margin: '0 0 12px', fontSize: 14 }}>
              {monnifyTest.ok ? (
                <p style={{ color: 'var(--green-500)', margin: 0 }}>Connected to Monnify ({monnifyTest.mode}). Keys are working.</p>
              ) : (
                <>
                  <p className="error-text" style={{ margin: 0 }}>Not connected: {monnifyTest.error}</p>
                  {(monnifyTest.hints || []).map((h) => (
                    <p key={h} style={{ color: 'var(--orange, #f97316)', margin: '4px 0 0' }}>{h}</p>
                  ))}
                </>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {saveButton('monnify', 'Save Monnify Settings')}
            <button type="button" className="btn btn-secondary" disabled={monnifyTest?.running} onClick={runMonnifyTest}>
              {monnifyTest?.running ? 'Testing…' : 'Test connection'}
            </button>
          </div>
        </form>
      )}

      {!loading && !loadError && tab === 'monnify' && (
        <form className="card" style={{ ...cardStyle, marginTop: 16 }} onSubmit={saveBankTransfers}>
          <SectionHeader
            title="Send to Bank"
            hint="Customers send money from their wallet to any bank account. It's paid out from your Monnify wallet, so keep that wallet funded."
          />
          <Status state={status.bankTransfers} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" checked={btEnabled} onChange={(e) => setBtEnabled(e.target.checked)} style={{ width: 'auto' }} />
            Allow customers to send to banks
          </label>
          <div className="field">
            <label htmlFor="walletAccount">Monnify wallet account number</label>
            <input id="walletAccount" inputMode="numeric" value={walletAccount} onChange={(e) => setWalletAccount(e.target.value)} placeholder="From Monnify → Developer → API Keys & Contracts" />
          </div>
          <div className="field">
            <label htmlFor="btFee">Fee per transfer (₦)</label>
            <input id="btFee" type="number" min="0" step="1" value={btFee} onChange={(e) => setBtFee(e.target.value)} />
            <small style={{ color: 'var(--slate-400)' }}>Charged to the customer on top of the amount. Set it to cover Monnify's transfer charge.</small>
          </div>
          <div className="field">
            <label htmlFor="btMin">Minimum per transfer (₦)</label>
            <input id="btMin" type="number" min="0" step="1" value={btMin} onChange={(e) => setBtMin(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="btMax">Maximum per transfer (₦)</label>
            <input id="btMax" type="number" min="0" step="1" value={btMax} onChange={(e) => setBtMax(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="btDaily">Daily limit per customer (₦)</label>
            <input id="btDaily" type="number" min="0" step="1" value={btDaily} onChange={(e) => setBtDaily(e.target.value)} />
          </div>
          <p style={{ color: 'var(--slate-400)', fontSize: 12, marginTop: 0 }}>
            In Monnify → Developer → Webhook URLs, put the same webhook URL in the Disbursement box too.
          </p>
          {saveButton('bankTransfers', 'Save Send to Bank Settings')}
        </form>
      )}

      {!loading && !loadError && tab === 'monnify' && (
        <div className="card" style={{ ...cardStyle, marginTop: 16, border: '1px solid var(--red-500)' }}>
          <SectionHeader
            title="Going live: reset account numbers"
            hint="Account numbers created in Sandbox don't work in Live. After switching the mode above to Live (and testing the connection), clear them here. Each customer just enters their BVN/NIN again next time they open Wallet and gets real account numbers. Wallet balances are not touched."
          />
          <p style={{ fontSize: 14, margin: '0 0 10px' }}>
            Customers with account numbers now: <strong>{accountsCount ?? '…'}</strong>
          </p>
          <Status state={resetState?.running ? null : resetState} />
          <div className="field">
            <label htmlFor="resetText">Type RESET to confirm</label>
            <input id="resetText" value={resetText} onChange={(e) => setResetText(e.target.value.toUpperCase())} autoComplete="off" />
          </div>
          <button type="button" className="btn btn-secondary" disabled={resetText !== 'RESET' || resetState?.running} onClick={runReset}>
            {resetState?.running ? 'Clearing…' : 'Clear all account numbers'}
          </button>
        </div>
      )}

      {!loading && !loadError && tab === 'markup' && (
        <form className="card" style={cardStyle} onSubmit={saveMarkup}>
          <SectionHeader title="Markup per service (%)" hint="Added on top of VTpass's own price for that service." />
          <Status state={status.markup} />
          {SERVICES.map((service) => (
            <div className="field" key={service}>
              <label htmlFor={`markup-${service}`}>{serviceLabel(service)}</label>
              <input
                id={`markup-${service}`}
                type="number"
                step="0.1"
                min="0"
                value={markupByService[service]}
                onChange={(e) => setMarkupByService((prev) => ({ ...prev, [service]: e.target.value }))}
              />
            </div>
          ))}
          {saveButton('markup', 'Save Markup')}
        </form>
      )}

      {!loading && !loadError && tab === 'discount' && (
        <form className="card" style={cardStyle} onSubmit={saveDiscount}>
          <SectionHeader
            title="Discount per service (%)"
            hint={'Taken off the marked-up price automatically on every purchase of that service. Customers see a "% OFF" badge on the dashboard and the discounted total before paying. Set to 0 to end a discount.'}
          />
          <Status state={status.discount} />
          {SERVICES.map((service) => {
            const markup = Number(markupByService[service] || 0);
            const discount = Number(discountByService[service] || 0);
            // Net effect on ₦100 of VTpass price — below 100 means this
            // service is now being sold under what VTpass charges us.
            const net = Math.round(100 * (1 + markup / 100)) * (1 - discount / 100);
            return (
              <div className="field" key={service}>
                <label htmlFor={`discount-${service}`}>{serviceLabel(service)}</label>
                <input
                  id={`discount-${service}`}
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={discountByService[service]}
                  onChange={(e) => setDiscountByService((prev) => ({ ...prev, [service]: e.target.value }))}
                />
                {discount > 0 && net < 100 && (
                  <p style={{ color: 'var(--orange)', fontSize: 12, margin: '4px 0 0' }}>
                    Heads up: this discount is bigger than the {markup}% markup, so {serviceLabel(service)} sells below VTpass cost.
                  </p>
                )}
              </div>
            );
          })}
          {saveButton('discount', 'Save Discounts')}
        </form>
      )}

      {!loading && !loadError && tab === 'limits' && (
        <form className="card" style={cardStyle} onSubmit={saveLimits}>
          <SectionHeader title="Limits & fees" hint="Smallest amounts customers can fund or spend, and the fee on automatic bank transfer funding." />
          <Status state={status.limits} />
          <div className="field">
            <label htmlFor="minFundingAmount">Minimum funding amount (₦)</label>
            <input id="minFundingAmount" type="number" step="1" min="0" value={minFundingAmount} onChange={(e) => setMinFundingAmount(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="minPurchaseAmount">Minimum purchase amount (₦)</label>
            <input id="minPurchaseAmount" type="number" step="1" min="0" value={minPurchaseAmount} onChange={(e) => setMinPurchaseAmount(e.target.value)} />
          </div>
          <div style={{ borderTop: '1px solid var(--slate-700)', margin: '8px 0 14px', paddingTop: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Manual funding account</div>
            <p style={{ color: 'var(--slate-400)', fontSize: 12, marginTop: 0 }}>
              Your business account customers transfer to, then submit for approval under Pending Funding. Leave the number empty to hide manual funding.
            </p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <input type="checkbox" checked={manualOn} onChange={(e) => setManualOn(e.target.checked)} style={{ width: 'auto' }} />
              Offer manual funding
            </label>
            <div className="field">
              <label htmlFor="manualBank">Bank name</label>
              <input id="manualBank" value={manualBank} onChange={(e) => setManualBank(e.target.value)} placeholder="e.g. Moniepoint" />
            </div>
            <div className="field">
              <label htmlFor="manualNumber">Account number</label>
              <input id="manualNumber" inputMode="numeric" maxLength={10} value={manualNumber} onChange={(e) => setManualNumber(e.target.value.replace(/\D/g, ''))} />
            </div>
            <div className="field">
              <label htmlFor="manualName">Account name</label>
              <input id="manualName" value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="e.g. SIRRADDO VENTURE" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="bankFeePercent">Bank transfer funding fee (%)</label>
            <input id="bankFeePercent" type="number" step="0.01" min="0" max="10" value={bankFeePercent} onChange={(e) => setBankFeePercent(e.target.value)} />
            <small style={{ color: 'var(--slate-400)' }}>Kept from money customers send to their personal account number. 0 = free.</small>
          </div>
          <div className="field">
            <label htmlFor="bankFeeCap">Maximum fee per transfer (₦)</label>
            <input id="bankFeeCap" type="number" step="1" min="0" value={bankFeeCap} onChange={(e) => setBankFeeCap(e.target.value)} />
            <small style={{ color: 'var(--slate-400)' }}>0 = no maximum.</small>
          </div>
          {saveButton('limits', 'Save Limits')}
        </form>
      )}

      {!loading && !loadError && tab === 'airtimeCash' && (
        <form className="card" style={cardStyle} onSubmit={saveAirtimeCash}>
          <SectionHeader
            title="Airtime to Cash"
            hint="Customers transfer airtime to your line for that network, then you approve it in Admin → Airtime to Cash and their wallet is credited minus the fee. Only networks with a number filled in can be chosen."
          />
          <Status state={status.airtimeCash} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 16, cursor: 'pointer' }}>
            <input type="checkbox" checked={a2cEnabled} onChange={(e) => setA2cEnabled(e.target.checked)} style={{ width: 'auto' }} />
            Accept Airtime to Cash requests
          </label>
          <div className="field">
            <label htmlFor="a2cFee">Service fee (%)</label>
            <input id="a2cFee" type="number" step="0.1" min="0" max="99" value={a2cFee} onChange={(e) => setA2cFee(e.target.value)} />
            <p style={{ color: 'var(--slate-400)', fontSize: 12, margin: '4px 0 0' }}>
              e.g. at {Number(a2cFee || 0)}%, ₦1,000 airtime pays out ₦{Math.floor(1000 * (1 - Number(a2cFee || 0) / 100)).toLocaleString()}.
            </p>
          </div>
          <div className="field">
            <label htmlFor="a2cMin">Minimum airtime amount (₦)</label>
            <input id="a2cMin" type="number" step="1" min="0" value={a2cMin} onChange={(e) => setA2cMin(e.target.value)} />
          </div>
          <h3 style={{ fontSize: 14, margin: '4px 0 8px' }}>Receiving numbers</h3>
          {A2C_NETWORKS.map((n) => (
            <div className="field" key={n.key}>
              <label htmlFor={`a2c-${n.key}`}>{n.label}</label>
              <input
                id={`a2c-${n.key}`}
                type="tel"
                inputMode="numeric"
                maxLength={11}
                value={a2cNumbers[n.key] || ''}
                onChange={(e) => setA2cNumbers((prev) => ({ ...prev, [n.key]: e.target.value }))}
                placeholder="Leave blank to not accept this network"
              />
            </div>
          ))}
          {saveButton('airtimeCash', 'Save Airtime to Cash')}
        </form>
      )}

      {!loading && !loadError && tab === 'loyalty' && (
        <form className="card" style={cardStyle} onSubmit={saveLoyalty}>
          <SectionHeader title="Loyalty points" hint="Customers earn points on every successful purchase and turn them into wallet credit. It's a cost to you, so keep the reward small." />
          <Status state={status.loyalty} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" checked={loyOn} onChange={(e) => setLoyOn(e.target.checked)} style={{ width: 'auto' }} />
            Give loyalty points
          </label>
          <div className="field">
            <label htmlFor="loyPer100">Points earned per ₦100 spent</label>
            <input id="loyPer100" type="number" step="0.1" min="0" value={loyPer100} onChange={(e) => setLoyPer100(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="loyValue">Value of 1 point when redeemed (₦)</label>
            <input id="loyValue" type="number" step="0.01" min="0" value={loyValue} onChange={(e) => setLoyValue(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="loyMin">Minimum points to redeem</label>
            <input id="loyMin" type="number" min="1" value={loyMin} onChange={(e) => setLoyMin(e.target.value)} />
          </div>
          <p style={{ fontSize: 13, color: 'var(--slate-400)', marginTop: 0 }}>
            With these numbers a customer gets back about <strong>{((Number(loyPer100 || 0) * Number(loyValue || 0))).toFixed(2)}%</strong> of what they spend
            (₦{((10000 / 100) * Number(loyPer100 || 0) * Number(loyValue || 0)).toLocaleString()} on every ₦10,000).
          </p>
          {saveButton('loyalty', 'Save Loyalty Settings')}
        </form>
      )}

      {!loading && !loadError && tab === 'security' && (
        <form className="card" style={cardStyle} onSubmit={saveSecurity}>
          <SectionHeader title="Security" />
          <Status state={status.security} />

          <div style={{ fontWeight: 600, marginBottom: 4 }}>Fraud check on bank transfers</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input type="checkbox" checked={fraudOn} onChange={(e) => setFraudOn(e.target.checked)} style={{ width: 'auto' }} />
            Hold large transfers for my review
          </label>
          <div className="field">
            <label htmlFor="fraudAmount">Hold transfers of at least (₦)</label>
            <input id="fraudAmount" type="number" min="0" value={fraudAmount} onChange={(e) => setFraudAmount(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="fraudHours">…made within this many hours of signup, a PIN/password change or a new-device login</label>
            <input id="fraudHours" type="number" min="1" max="720" value={fraudHours} onChange={(e) => setFraudHours(e.target.value)} />
            <small style={{ color: 'var(--slate-400)' }}>Held transfers wait under Bank Transfers → Held. You'll get an email for each one.</small>
          </div>

          <div style={{ borderTop: '1px solid var(--slate-700)', margin: '14px 0', paddingTop: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Two-step admin login</div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <input type="checkbox" checked={twoFactor} onChange={(e) => setTwoFactor(e.target.checked)} style={{ width: 'auto' }} />
              Email a 6-digit code on every admin login
            </label>
            <p style={{ color: 'var(--slate-400)', fontSize: 12, margin: 0 }}>
              Admins can tick “Trust this device for 30 days”. Test that your admin email receives messages (e.g. with the summary test below) before turning this on. Emergency: adding ADMIN_2FA_DISABLED = 1 on Render turns it off.
            </p>
          </div>

          <div style={{ borderTop: '1px solid var(--slate-700)', margin: '14px 0', paddingTop: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Daily summary email</div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input type="checkbox" checked={summaryOn} onChange={(e) => setSummaryOn(e.target.checked)} style={{ width: 'auto' }} />
              Email admins yesterday's numbers at 7am
            </label>
            <button type="button" className="btn btn-secondary" style={{ width: 'auto' }} disabled={summaryTest?.running} onClick={runSummaryTest}>
              {summaryTest?.running ? 'Sending…' : 'Send me a summary now'}
            </button>
            {summaryTest && !summaryTest.running && (
              <p style={{ fontSize: 13, margin: '6px 0 0', color: summaryTest.ok ? 'var(--green-500)' : 'var(--red-500)' }}>{summaryTest.text}</p>
            )}
          </div>

          {saveButton('security', 'Save Security Settings')}
        </form>
      )}

      {!loading && !loadError && tab === 'agents' && (
        <form className="card" style={cardStyle} onSubmit={saveAgents}>
          <SectionHeader
            title="Agent / reseller pricing"
            hint="Approved agents get this extra % off each service, on top of any normal discount. Customers apply from their Profile; you approve them on the Overview or their customer page. Keep it below your markup so you still make a profit."
          />
          <Status state={status.agents} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" checked={agentOn} onChange={(e) => setAgentOn(e.target.checked)} style={{ width: 'auto' }} />
            Open agent accounts (show "Become an agent" to customers)
          </label>
          {SERVICES.map((service) => (
            <div className="field" key={service}>
              <label htmlFor={`ag-${service}`}>{serviceLabel(service)} — extra % off for agents</label>
              <input id={`ag-${service}`} type="number" step="0.1" min="0" max="50" value={agentByService[service]} onChange={(e) => setAgentByService((m) => ({ ...m, [service]: e.target.value }))} />
            </div>
          ))}
          {saveButton('agents', 'Save Agent Pricing')}
        </form>
      )}

      {!loading && !loadError && tab === 'cashback' && (
        <form className="card" style={cardStyle} onSubmit={saveCashback}>
          <SectionHeader title="Cashback" hint="After a successful purchase, this % of the price goes back into the customer's wallet. It comes out of your profit — keep it below your markup." />
          <Status state={status.cashback} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" checked={cbEnabled} onChange={(e) => setCbEnabled(e.target.checked)} style={{ width: 'auto' }} />
            Give cashback
          </label>
          {SERVICES.map((service) => (
            <div className="field" key={service}>
              <label htmlFor={`cb-${service}`}>{serviceLabel(service)} (%)</label>
              <input id={`cb-${service}`} type="number" step="0.1" min="0" max="20" value={cbByService[service]} onChange={(e) => setCbByService((m) => ({ ...m, [service]: e.target.value }))} />
            </div>
          ))}
          <div className="field">
            <label htmlFor="cbMax">Maximum cashback per purchase (₦)</label>
            <input id="cbMax" type="number" min="0" value={cbMax} onChange={(e) => setCbMax(e.target.value)} />
          </div>
          {saveButton('cashback', 'Save Cashback')}
        </form>
      )}

      {!loading && !loadError && tab === 'alerts' && (
        <form className="card" style={cardStyle} onSubmit={saveAlerts}>
          <SectionHeader title="Alerts, limits & support" />
          <Status state={status.alerts} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <input type="checkbox" checked={alertsOn} onChange={(e) => setAlertsOn(e.target.checked)} style={{ width: 'auto' }} />
            Send email alerts (money in/out, new logins)
          </label>
          <p style={{ color: 'var(--slate-400)', fontSize: 12, margin: '0 0 14px' }}>
            Uses your Resend email setup. Resend's free plan allows 100 emails a day — upgrade Resend before you have many customers.
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input type="checkbox" checked={limitsOn} onChange={(e) => setLimitsOn(e.target.checked)} style={{ width: 'auto' }} />
            Daily spending limits by verification level
          </label>
          <div className="field">
            <label htmlFor="limU">Not verified — daily limit (₦)</label>
            <input id="limU" type="number" min="0" value={limitUnverified} onChange={(e) => setLimitUnverified(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="limV">Verified with BVN/NIN — daily limit (₦)</label>
            <input id="limV" type="number" min="0" value={limitVerified} onChange={(e) => setLimitVerified(e.target.value)} />
            <small style={{ color: 'var(--slate-400)' }}>Covers purchases, ZappiPay transfers and bank transfers per day.</small>
          </div>
          <div className="field">
            <label htmlFor="wa">Support WhatsApp number</label>
            <input id="wa" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="e.g. 08012345678" />
            <small style={{ color: 'var(--slate-400)' }}>The number customers reach from "Chat on WhatsApp" in Profile and the help chat. Leave empty to keep the current number (08134209037).</small>
          </div>
          {saveButton('alerts', 'Save')}
        </form>
      )}

      {!loading && !loadError && tab === 'referral' && (
        <form className="card" style={cardStyle} onSubmit={saveReferral}>
          <SectionHeader
            title="Referral program"
            hint="Each customer's username is their referral code. When someone signs up with a code and completes a first successful purchase of at least the minimum below, the referrer's wallet is credited the bonus — once per referred customer."
          />
          <Status state={status.referral} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 16, cursor: 'pointer' }}>
            <input type="checkbox" checked={refEnabled} onChange={(e) => setRefEnabled(e.target.checked)} style={{ width: 'auto' }} />
            Pay referral bonuses
          </label>
          <div className="field">
            <label htmlFor="refBonus">Bonus per referral (₦)</label>
            <input id="refBonus" type="number" step="1" min="0" value={refBonus} onChange={(e) => setRefBonus(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="refMin">Referred customer's first purchase must be at least (₦)</label>
            <input id="refMin" type="number" step="1" min="0" value={refMin} onChange={(e) => setRefMin(e.target.value)} />
            <p style={{ color: 'var(--slate-400)', fontSize: 12, margin: '4px 0 0' }}>
              A higher minimum makes it harder for people to farm bonuses with fake accounts. Keep the bonus below your margin on that purchase.
            </p>
          </div>
          {saveButton('referral', 'Save Referral Settings')}
        </form>
      )}

      {tab === 'password' && (
        <form className="card" style={cardStyle} onSubmit={savePassword}>
          <SectionHeader title="Change My Password" />
          <Status state={status.password} />
          <div className="field">
            <label htmlFor="currentPassword">Current password</label>
            <PasswordField id="currentPassword" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoComplete="current-password" />
          </div>
          <div className="field">
            <label htmlFor="newPassword">New password</label>
            <PasswordField id="newPassword" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={6} autoComplete="new-password" />
          </div>
          {saveButton('password', 'Change Password')}
        </form>
      )}
    </AdminLayout>
  );
}
