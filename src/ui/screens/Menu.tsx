import { useRef, useState } from 'react';
import type { BotName } from '../../ai';
import { replayFrames, upgradeReplay, type PresetName, type Replay } from '../../engine';
import { RulesPane } from '../components/RulesPane';
import {
  MODE_LABEL,
  fleetsFor,
  type Mode,
  type Setup,
  type UIAction,
} from '../state';

// MODE is two independent picks: the ruleset, then how many fleets share the water. ROLE
// is whether you are in it.
const PRESET_NAMES: PresetName[] = ['CLASSIC', 'SALVO', 'FLOTILLA'];
const MODES: Mode[] = ['duel', 'open'];

const PRESET_BLURB: Record<PresetName, string> = {
  CLASSIC: 'one shot per turn. nothing else.',
  SALVO: 'AP budget = remaining ships. shots only.',
  FLOTILLA: 'full doctrine.',
};

const MODE_BLURB: Record<Mode, string> = {
  duel: 'deathmatch. two fleets, one survivor.',
  open: 'battle royale. three fleets, no allies, no harbor.',
};

const ROLE_BLURB: Record<'duty' | 'exercise', string> = {
  duty: 'search and destroy the enemy while evading detection.',
  exercise: 'spectate simulated combat.',
};

const BOT_BLURB: Record<BotName, string> = {
  ensign: 'random actor. biased toward shooting.',
  lieutenant: 'reacts to how you budget AP, scouts until a shot stands out.',
  commander: 'classic heatmap. shoots only, ignores movement.',
  captain: 'evades your heatmap, less aggressive, but hunts late.',
  commodore: 'hides under previous misses. senses and deceives to finish.',
  admiral: 'weighs every action by payoff. scouts, hides, then strikes.',
};

// Ascending naval rank, laid out as a fixed 3x2 grid.
const BOTS: BotName[] = ['ensign', 'lieutenant', 'commander', 'captain', 'commodore', 'admiral'];
// Shots-only rulesets offer just the top row: the other ranks differ only in pings, moves
// and decoys.
const SHOTS_ONLY_BOTS: BotName[] = ['ensign', 'lieutenant', 'commander'];
const offeredFor = (preset: PresetName): BotName[] => (preset === 'FLOTILLA' ? BOTS : SHOTS_ONLY_BOTS);
// A seat crewed by a greyed-out rank sails as LIEUTENANT, its shots-only twin; the pick
// itself is kept, so switching back to FLOTILLA restores it.
const fieldedFor = (preset: PresetName, bot: BotName): BotName =>
  offeredFor(preset).includes(bot) ? bot : 'lieutenant';

export function Menu(props: { dispatch: (a: UIAction) => void }) {
  const [preset, setPreset] = useState<PresetName>('FLOTILLA');
  const [fleets, setFleets] = useState<Mode>('duel');
  const [cpuA, setCpuA] = useState<BotName>('admiral');
  const [cpuB, setCpuB] = useState<BotName>('commander');
  const [cpuC, setCpuC] = useState<BotName>('commodore');
  const [human, setHuman] = useState(true);
  // Which CPU seat the next roster click crews. Round-robins so clicking one bot twice
  // puts it in two seats.
  const [cursor, setCursor] = useState(0);
  const [showRules, setShowRules] = useState(false);
  // Rolled once per menu visit, so reopening HOW TO PLAY keeps the same flavor line.
  const [flavorRoll] = useState(Math.random);
  const [replayError, setReplayError] = useState<string | null>(null);
  const replayFile = useRef<HTMLInputElement>(null);

  // File read is the effect at the edge; validation = re-executing the whole
  // log through the engine (replayFrames throws on anything corrupt).
  const loadReplay = async (file: File) => {
    try {
      const replay = upgradeReplay(JSON.parse(await file.text()) as Replay);
      if (replay.version !== 2 && replay.version !== 3) {
        throw new Error('unsupported replay version');
      }
      replayFrames(replay);
      setReplayError(null);
      props.dispatch({
        t: 'OPEN_REPLAY',
        replay,
        labels: replay.placements.map((_, i) => `P${i + 1}`),
        from: 'menu',
      });
    } catch {
      setReplayError('NOT A VALID FLOTILLA REPLAY');
    }
  };

  // One roster, however many CPU seats the two axes leave open.
  const fielded = (b: BotName) => fieldedFor(preset, b);
  const offered = offeredFor(preset);
  const lineup = [cpuA, cpuB, cpuC].slice(0, fleetsFor(fleets) - (human ? 1 : 0)).map(fielded);
  // Modulo: narrowing the mode or ROLE can drop the seat the cursor sits on.
  const cursorAt = cursor % lineup.length;
  const crew = (b: BotName) => {
    [setCpuA, setCpuB, setCpuC][cursorAt]?.(b);
    setCursor((cursorAt + 1) % lineup.length);
  };
  // Which seats each distinct bot holds, in roster-rank order.
  const distinct = BOTS.filter((b) => lineup.includes(b)).map((b) => ({
    bot: b,
    tags: lineup.flatMap((x, i) => (x === b ? [i] : [])),
  }));
  const start = () => {
    const setup: Setup = {
      mode: fleets,
      preset,
      cpuA: fielded(cpuA),
      cpuB: fielded(cpuB),
      cpuC: fielded(cpuC),
      human,
      seed: ((Math.random() * 0x7fffffff) | 0) >>> 0,
    };
    props.dispatch({ t: 'START_SETUP', setup });
  };

  return (
    <div className="menu-screen">
      <div className="menu-core">
        <h1 className="wordmark">FLOTILLA</h1>
        <div className="menu-sub micro-label">NAVAL ACTION-ECONOMY WARGAME · C2 CONSOLE</div>

        <div className="menu-section">
          <div className="micro-label">MODE</div>
          <div className="choice-row">
            {PRESET_NAMES.map((p) => (
              <button
                key={p}
                type="button"
                className={`btn-choice${preset === p ? ' selected' : ''}`}
                onClick={() => setPreset(p)}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="choice-row">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`btn-choice${fleets === m ? ' selected' : ''}`}
                onClick={() => setFleets(m)}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <div className="menu-hint">
            {MODE_BLURB[fleets]}
            {fleets === 'open' && preset === 'FLOTILLA' ? '' : ` ${PRESET_BLURB[preset]}`}
          </div>
        </div>

        <div className="menu-section">
          <div className="micro-label">ROLE</div>
          <div className="choice-row">
            <button
              type="button"
              className={`btn-choice${human ? ' selected' : ''}`}
              onClick={() => setHuman(true)}
            >
              ACTIVE DUTY
            </button>
            <button
              type="button"
              className={`btn-choice${!human ? ' selected' : ''}`}
              onClick={() => setHuman(false)}
            >
              FLEET EXERCISE
            </button>
          </div>
          <div className="menu-hint">{ROLE_BLURB[human ? 'duty' : 'exercise']}</div>
        </div>

        <div className="menu-section">
          <div className="micro-label">
            {/* On FLEET EXERCISE nobody is your opponent: every seat is fighting every other. */}
            {!human ? 'COMBATANTS' : lineup.length === 1 ? 'OPPONENT' : 'OPPONENTS'}
          </div>
          <div className="seat-legend">
            {lineup.map((bot, i) => (
              <button
                key={i}
                type="button"
                className={`seat-chip seat-${i + 1}${cursorAt === i ? ' active' : ''}`}
                onClick={() => setCursor(i)}
              >
                {bot.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="choice-grid">
            {BOTS.map((b) => {
              const held = lineup.flatMap((bot, i) => (bot === b ? [i] : []));
              const lead = held[0];
              const tone = held.length > 1 ? ' seat-mirror' : lead === undefined ? '' : ` seat-${lead + 1}`;
              return (
                <button
                  key={b}
                  type="button"
                  className={`btn-choice btn-fleet${tone}`}
                  disabled={!offered.includes(b)}
                  onClick={() => crew(b)}
                >
                  {b.toUpperCase()}
                  {held.length > 0 && (
                    <span className="fleet-pips">
                      {held.map((i) => (
                        <span key={i} className={`fleet-pip seat-${i + 1}`} />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {/* Three slots always reserved so the roster doesn't jump. */}
          <div className="fleet-blurbs">
            {distinct.map(({ bot, tags }) => (
              <div key={bot} className="menu-hint menu-hint--bot">
                {tags.map((i) => (
                  <span key={i} className={`fleet-tag seat-${i + 1}`} />
                ))}
                {BOT_BLURB[bot]}
              </div>
            ))}
          </div>
        </div>

        <div className="menu-actions">
          <button type="button" className="btn-primary" onClick={start}>
            {human ? 'DEPLOY' : 'OBSERVE'}
          </button>
          <button type="button" className="btn-choice" onClick={() => setShowRules(true)}>
            HOW TO PLAY
          </button>
          <button type="button" className="btn-choice" onClick={() => replayFile.current?.click()}>
            LOAD REPLAY
          </button>
          <input
            ref={replayFile}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) void loadReplay(file);
            }}
          />
        </div>
        {replayError && <div className="menu-hint">{replayError}</div>}
      </div>
      {showRules && (
        <RulesPane
          mode={fleets}
          preset={preset}
          flavorRoll={flavorRoll}
          onClose={() => setShowRules(false)}
        />
      )}
      <div className="menu-version">v{__APP_VERSION__}</div>
    </div>
  );
}
