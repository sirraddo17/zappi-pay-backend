import { useEffect, useState } from 'react';
import PasswordField from '../../components/PasswordField';
import AdminLayout from '../../components/AdminLayout';
import { getSettings, updateSettings, changeAdminPassword } from '../../api';

const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNET', 'BETTING'];

// Each tab is its own form with its own Save button, and only sends
// the fields that belong to it — PATCH /admin/settings already
// accepts partial updates, so saving discounts can never overwrite
// the VTpass keys (or vice versa) with stale values from another tab.
const TABS = [
  { key: 'vtpass', label: 'VTpass' },
  { key: 'markup', label: 'Markup' },
  { key: 'discount', label: 'Discounts' },
  { key: 'limits', label: 'Limits' },
  { key: 'airtimeCash', label: 'Airtime to Cash' },
  { key: 'referral', label: 'Referrals' },
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
  const [minFundingAmount, setMinFundingAmount] = useState('100');
  const [minPurchaseAmount, setMinPurchaseAmount] = useState('50');
  const [bankFeePercent, setBankFeePercent] = useState('0');
  const [bankFeeCap, setBankFeeCap] = useState('0');

  const [a2cEnabled, setA2cEnabled] = useState(false);
  const [a2cFee, setA2cFee] = useState('20');
  const [a2cMin, setA2cMin] = useState('500');
  const [a2cNumbers, setA2cNumbers] = useState({});

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
        setMinFundingAmount(String(s.minFundingAmount ?? 100));
        setMinPurchaseAmount(String(s.minPurchaseAmount ?? 50));
        setBankFeePercent(String(s.bankFundingFeePercent ?? 0));
        setBankFeeCap(String(s.bankFundingFeeCap ?? 0));
        setA2cEnabled(Boolean(s.airtimeToCashEnabled));
        setA2cFee(String(s.airtimeToCashFeePercent ?? 20));
        setA2cMin(String(s.airtimeToCashMinAmount ?? 500));
        setA2cNumbers(s.airtimeToCashNumbers || {});
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
    save(
      'limits',
      {
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
