import React, { useState } from 'react';
import { 
  X, 
  Bot, 
  Activity, 
  ShieldCheck, 
  Search, 
  Zap, 
  Clock, 
  CheckCircle2, 
  Radio, 
  Filter,
  ExternalLink
} from 'lucide-react';
import { BotScout } from '../types';

interface BotSwarmModalProps {
  isOpen: boolean;
  onClose: () => void;
  bots: BotScout[];
}

export const BotSwarmModal: React.FC<BotSwarmModalProps> = ({
  isOpen,
  onClose,
  bots,
}) => {
  const [filterPlatform, setFilterPlatform] = useState<string>('All');

  if (!isOpen) return null;

  const filteredBots = filterPlatform === 'All' 
    ? bots 
    : bots.filter(b => b.platform.toLowerCase().includes(filterPlatform.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-4xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4 bg-slate-950/70">
          <div className="flex items-center gap-3">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-950 border border-cyan-800/80 text-cyan-400">
              <Bot className="h-5 w-5" />
              <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">Autonomous Research Swarm</h2>
                <span className="rounded bg-emerald-950/80 px-2 py-0.5 text-[10px] font-mono font-semibold text-emerald-400 border border-emerald-800/60">
                  10/10 NOMINAL
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Continuous autonomous market intelligence agents monitoring permitted public sources.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Ethics & Protocol Banner */}
        <div className="border-b border-slate-800/80 bg-cyan-950/20 px-6 py-3 flex items-start gap-3">
          <ShieldCheck className="h-4 w-4 text-cyan-400 shrink-0 mt-0.5" />
          <div className="text-xs text-slate-300">
            <strong className="text-cyan-300">Autonomous Operation Guarantee:</strong>{' '}
            These bots do not pretend to be human, never engage in synthetic conversations, and post zero messages. Their sole mandate is ethical observational research across public APIs, RSS feeds, and permitted forums to protect data veracity.
          </div>
        </div>

        {/* Global Swarm Telemetry Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-6 py-4 bg-slate-950/40 border-b border-slate-800/60">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>Throughput</span>
              <Activity className="h-3.5 w-3.5 text-cyan-400" />
            </div>
            <div className="text-lg font-bold font-mono text-white">529 <span className="text-xs text-slate-400 font-sans font-normal">scans/min</span></div>
            <div className="text-[10px] text-emerald-400 mt-0.5 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
              Synchronized 100%
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>Discussions Indexed (24h)</span>
              <Search className="h-3.5 w-3.5 text-blue-400" />
            </div>
            <div className="text-lg font-bold font-mono text-white">48,920</div>
            <div className="text-[10px] text-cyan-400 mt-0.5">+14% vs yesterday</div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>Identified Problem Clusters</span>
              <Zap className="h-3.5 w-3.5 text-amber-400" />
            </div>
            <div className="text-lg font-bold font-mono text-white">342</div>
            <div className="text-[10px] text-amber-400 mt-0.5">Deduplicated in real-time</div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>Scoring Precision</span>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            </div>
            <div className="text-lg font-bold font-mono text-white">99.4%</div>
            <div className="text-[10px] text-slate-400 mt-0.5">Audited by Research Auditor</div>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-800/60 bg-slate-950/20">
          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-slate-400" />
            <span className="text-xs font-semibold text-slate-300">Target Platform:</span>
            {['All', 'Reddit', 'X / Twitter', 'GitHub', 'Reviews', 'Analysis'].map((plat) => (
              <button
                key={plat}
                onClick={() => setFilterPlatform(plat)}
                className={`px-2 py-0.5 rounded text-xs transition-colors cursor-pointer ${
                  filterPlatform === plat
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-800 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {plat}
              </button>
            ))}
          </div>
          <span className="text-xs font-mono text-slate-500">{filteredBots.length} bots displayed</span>
        </div>

        {/* Bot Cards List */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {filteredBots.map((bot) => (
            <div
              key={bot.id}
              className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 hover:border-slate-700 transition-all"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/50 pb-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 border border-slate-800 text-cyan-400 font-mono text-xs font-bold">
                    {bot.id.replace('bot-', '#0')}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-white">{bot.name}</span>
                      <span className="rounded bg-slate-900 px-2 py-0.5 text-[10px] font-mono text-slate-300 border border-slate-800">
                        {bot.platform}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">{bot.role}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 text-xs">
                  <div className="flex items-center gap-1.5 font-mono text-slate-300 bg-slate-900/80 px-2.5 py-1 rounded border border-slate-800">
                    <Activity className="h-3 w-3 text-cyan-400 animate-pulse" />
                    <span>{bot.speed}</span>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium capitalize ${
                    bot.status === 'active' ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/60' :
                    bot.status === 'analyzing' ? 'bg-blue-950 text-blue-300 border border-blue-800/60' :
                    bot.status === 'generating' ? 'bg-purple-950 text-purple-300 border border-purple-800/60' :
                    'bg-amber-950 text-amber-300 border border-amber-800/60'
                  }`}>
                    <span className="h-1.5 w-1.5 rounded-full bg-current"></span>
                    {bot.status}
                  </span>
                </div>
              </div>

              {/* Targets & Live Findings */}
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg bg-slate-900/40 p-2.5 border border-slate-800/50">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 block mb-1">
                    Target Communities & Queries
                  </span>
                  <span className="font-mono text-slate-300 text-[11px]">{bot.target}</span>
                </div>

                <div className="rounded-lg bg-cyan-950/20 p-2.5 border border-cyan-900/40">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400 block mb-1">
                    Latest Discovered Complaint / Signal
                  </span>
                  <p className="text-slate-200 text-xs italic">
                    "{bot.lastFinding}"
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-800 px-6 py-3 bg-slate-950 flex items-center justify-between text-xs text-slate-400">
          <span>Continuous operation cycle: 24/7/365</span>
          <button
            onClick={onClose}
            className="rounded-lg bg-slate-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-700 transition-colors cursor-pointer"
          >
            Close Swarm Inspector
          </button>
        </div>
      </div>
    </div>
  );
};
