// TEMPORARY admin diagnostic (see src/lib/aiSmokeTest.ts). Rendered only for administrators, but the backend decides who may run it.
import React, { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FlaskConical, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { createSmokeController, EngineView, ParsedReport, runAiSmokeTest, SmokeController, SmokeState, Tone } from '../lib/aiSmokeTest';

const TONE_CLS: Record<Tone, string> = {
  ok: 'text-emerald-300 border-emerald-800 bg-emerald-950/30',
  warn: 'text-amber-300 border-amber-800 bg-amber-950/30',
  fail: 'text-rose-300 border-rose-800 bg-rose-950/30',
  neutral: 'text-slate-300 border-slate-700 bg-slate-900',
};
const TONE_ICON: Record<Tone, React.ElementType> = { ok: CheckCircle2, warn: AlertTriangle, fail: XCircle, neutral: MinusCircle };
const OVERALL: Record<ParsedReport['overall'], { text: string; tone: Tone }> = {
  passed: { text: 'Overall: both engines passed', tone: 'ok' },
  partial: { text: 'Overall: partial. At least one engine did not pass', tone: 'warn' },
  failed: { text: 'Overall: failed. No engine gave a usable answer', tone: 'fail' },
  nothing_tested: { text: 'Overall: nothing was tested', tone: 'neutral' },
};

const EngineCard: React.FC<{ engine: EngineView }> = ({ engine }) => {
  const Icon = TONE_ICON[engine.tone];
  return (
    <section aria-label={engine.label} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-white">{engine.label}</h3>
          {engine.model && <p className="text-[10px] font-mono text-slate-500 break-all">{engine.model}</p>}
        </div>
        <span className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono ${TONE_CLS[engine.tone]}`}><Icon className="h-3 w-3" /> {engine.headline}</span>
      </div>
      <dl className="space-y-2 text-[11px]">
        {engine.rows.map((r) => {
          const RowIcon = TONE_ICON[r.tone];
          return (
            <div key={r.label} className="flex gap-2">
              <RowIcon className={`mt-0.5 h-3 w-3 shrink-0 ${TONE_CLS[r.tone].split(' ')[0]}`} aria-hidden />
              <div className="min-w-0"><dt className="text-slate-500">{r.label}</dt><dd className="text-slate-200 break-words">{r.value}</dd></div>
            </div>
          );
        })}
      </dl>
    </section>
  );
};

const ReportView: React.FC<{ report: ParsedReport; completedAt: string }> = ({ report, completedAt }) => {
  const o = OVERALL[report.overall];
  return (
    <div className="space-y-3" data-testid="smoke-report">
      <div className={`rounded-lg border px-3 py-2 text-xs ${TONE_CLS[o.tone]}`}>
        <p className="font-semibold">{o.text}</p>
        <p className="mt-1 text-[11px] opacity-80">
          Completed <time dateTime={completedAt}>{new Date(completedAt).toLocaleString()}</time> · took {(report.elapsedMs / 1000).toFixed(1)}s ·
          {' '}{report.records.selected} of up to {report.maxRecords} pending records used ({report.records.eligible} eligible of {report.records.candidatesRead} read)
        </p>
        {report.note && <p className="mt-1 text-[11px] break-words">{report.note}</p>}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {report.engines.map((e) => <EngineCard key={e.key} engine={e} />)}
      </div>
    </div>
  );
};

interface ViewProps { state: SmokeState; onRequest: () => void; onConfirm: () => void; onCancel: () => void }

/** Presentational part: everything it shows is decided by `state`, so it can be rendered and tested without a browser. */
export const AiSmokeTestPanelView: React.FC<ViewProps> = ({ state, onRequest, onConfirm, onCancel }) => {
  const running = state.phase === 'running';
  return (
    <section aria-label="AI smoke test" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-3">
      <div className="flex items-start gap-3">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
        <div>
          <h2 className="text-sm font-bold text-white">AI engine check <span className="ml-1 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] font-mono text-slate-400">temporary</span></h2>
          <p className="text-[11px] text-slate-400 mt-0.5">Tests Decisions Fast and LFM3 separately on at most 3 existing pending records. Collects nothing new and changes no records.</p>
        </div>
      </div>

      {state.phase === 'confirming' ? (
        <div role="alertdialog" aria-label="Confirm AI smoke test" className="rounded-lg border border-amber-800/70 bg-amber-950/20 p-3 space-y-3 text-xs text-amber-100">
          <p className="font-semibold">Run the AI smoke test now?</p>
          <p className="text-[11px] text-amber-200/90">It sends up to 3 existing records to the free Decisions Fast and LFM3 models (one attempt each, no retries), may update the AI cache and usage counters, and can take up to two minutes. Keep this page open.</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <button onClick={onConfirm} className="min-h-[44px] rounded-lg bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 cursor-pointer">Yes, run the test</button>
            <button onClick={onCancel} className="min-h-[44px] rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700 cursor-pointer">Cancel</button>
          </div>
        </div>
      ) : (
        <button
          onClick={onRequest}
          disabled={running}
          aria-busy={running}
          className="flex min-h-[44px] w-full sm:w-auto items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 disabled:opacity-60 cursor-pointer"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
          {running ? 'Running… this can take up to 2 minutes' : 'Run AI Smoke Test'}
        </button>
      )}

      {state.phase === 'error' && (
        <div role="alert" className={`rounded-lg border px-3 py-2 text-xs break-words ${TONE_CLS.fail}`}>
          <p className="font-semibold">{state.kind === 'session' ? 'Session problem' : state.kind === 'unrecognised' ? 'Unrecognised response' : 'The test could not be run'}</p>
          <p className="mt-1 text-[11px]">{state.message}</p>
        </div>
      )}
      {state.phase === 'done' && <ReportView report={state.report} completedAt={state.completedAt} />}
    </section>
  );
};

/** Admin-only container. Never runs anything on mount: a run needs a tap and a confirmation. */
export const AiSmokeTestPanel: React.FC = () => {
  const [state, setState] = useState<SmokeState>({ phase: 'idle' });
  const controller = useRef<SmokeController | null>(null);
  if (!controller.current) controller.current = createSmokeController(() => runAiSmokeTest(supabase), setState);
  const c = controller.current;
  return <AiSmokeTestPanelView state={state} onRequest={() => c.request()} onConfirm={() => { void c.confirm(); }} onCancel={() => c.cancel()} />;
};
