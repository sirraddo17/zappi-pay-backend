import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDailyRewards, dailyCheckin, dailyQuiz } from '../../api';
import BottomNav from '../../components/BottomNav';
import { naira } from '../../components/circles/shared';

export default function DailyRewards() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [quiz, setQuiz] = useState(null);
  const load = () => getDailyRewards().then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!d) return <div className="app-shell">{err ? <p className="error-text" style={{ margin: 16 }}>{err}</p> : <p className="empty-state">Loading…</p>}</div>;
  const inWeek = d.checkedIn ? ((d.streak - 1) % 7) + 1 : d.streak % 7;
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header"><Link to="/more" style={{ color: 'var(--purple)', textDecoration: 'none', fontSize: 14 }}>← Back</Link><h1>🎁 Daily rewards</h1><p>Check in every day and answer one quick question. Rewards go to your cashback balance.</p></div>
      {err && <p className="error-text" style={{ margin: '0 16px' }}>{err}</p>}
      {msg && <p style={{ color: 'var(--green-500)', margin: '0 16px', fontSize: 14 }}>{msg}</p>}
      {!d.enabled && <p className="card" style={{ fontSize: 14 }}>Daily rewards are paused right now.</p>}
      {d.enabled && !d.verified && <div className="card" style={{ fontSize: 14 }}>Verify your account to start earning — <Link to="/wallet" style={{ color: 'var(--purple)' }}>get your account number on the Wallet page</Link>.</div>}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><b>🔥 {d.streak}-day streak</b>{d.nextStreakReward > 0 && <small style={{ color: 'var(--gold)' }}>{naira(d.nextStreakReward)} on every 7th day</small>}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, margin: '12px 0' }}>
          {Array.from({ length: 7 }, (_, i) => <div key={i} style={{ textAlign: 'center', padding: '8px 0', borderRadius: 8, fontSize: 13, fontWeight: 700, background: i < inWeek ? 'var(--purple)' : 'var(--slate-800)', color: i < inWeek ? '#fff' : 'var(--slate-400)' }}>{i === 6 ? '🎁' : i + 1}</div>)}
        </div>
        {d.checkedIn ? <p style={{ fontSize: 14, margin: 0 }}>✅ Checked in today. {d.daysToReward > 0 ? `${d.daysToReward} more day${d.daysToReward === 1 ? '' : 's'} to your reward.` : ''} Come back tomorrow!</p>
          : <button type="button" className="btn" disabled={!d.enabled || !d.verified} onClick={() => dailyCheckin().then((r) => { setMsg(r.reward > 0 ? `🔥 7 days! ${naira(r.reward)} cashback added.` : `Checked in ✓ — day ${r.streak}`); load(); }).catch((e) => setErr(e.message))}>Check in for today</button>}
        <p style={{ fontSize: 12, color: 'var(--slate-400)', marginBottom: 0 }}>Miss a day and the streak starts again.</p>
      </div>
      <div className="card">
        <b>🎯 Question of the day</b>{d.quiz.reward > 0 && <small style={{ color: 'var(--gold)' }}> · {naira(d.quiz.reward)} if you’re right</small>}
        <p style={{ fontSize: 15 }}>{d.quiz.question}</p>
        {d.quiz.options.map((o, i) => {
          const picked = quiz?.choice === i;
          const right = quiz && quiz.answer === i;
          return <button key={o} type="button" disabled={Boolean(quiz) || d.quiz.done || !d.checkedIn} className="btn btn-secondary" style={{ display: 'block', marginBottom: 6, textAlign: 'left', borderColor: right ? 'var(--green-500)' : picked ? 'var(--red-500)' : undefined }} onClick={() => dailyQuiz(i).then((r) => { setQuiz({ ...r, choice: i }); setMsg(r.correct ? (r.reward > 0 ? `Correct! ${naira(r.reward)} cashback added 🎉` : r.budgetUsedUp ? 'Correct! Today’s reward pot is used up — try again tomorrow.' : 'Correct! 🎉') : 'Not quite — see the right answer in green.'); load(); }).catch((e) => setErr(e.message))}>{right ? '✅ ' : picked ? '❌ ' : ''}{o}</button>;
        })}
        {!d.checkedIn && <p style={{ fontSize: 12, color: 'var(--slate-400)' }}>Check in first, then answer.</p>}
        {d.quiz.done && !quiz && <p style={{ fontSize: 13, color: 'var(--slate-400)' }}>You’ve answered today’s question. New one tomorrow!</p>}
      </div>
      <p style={{ fontSize: 12, color: 'var(--slate-400)', margin: '0 16px' }}>Rewards are limited each day and can change. One account per person.</p>
      <BottomNav />
    </div>
  );
}

