import { useEffect } from 'react';
import {
  AP_CAP,
  AP_COST,
  AP_FLOOR,
  ECHO_SIZE,
  FLEET,
  MAX_DECOYS,
  MAX_TURNS,
  PRESETS,
  TOOL_COOLDOWN,
  SCAN_SIZE,
  SPRAY_SIZE,
  toolCost,
  type PresetName,
} from '../../engine';
import { SHIP_LABEL } from '../format';
import type { Mode } from '../state';

// Menu overlay: the full ruleset on one screen.

// MELEE's closing line, one drawn per menu visit (the caller owns the roll).
const OPEN_WATER_FLAVOR = [
  'Two fleets make a duel. Three make a hunt. Every shot you fire is a lantern lit for the ' +
    'one you forgot to watch...',
  'A fleetmaster fears the enemy he can see. A wise one fears the one watching him fight it...',
  'Two hunters can circle forever. Add a third, and someone is always the prey...',
  'Fire at one, and the other learns where you are. Hold your fire, and both do...',
  'The first to strike is the first to be seen. The last to strike is the last to drown...',
];

export function RulesPane(props: {
  mode: Mode;
  preset: PresetName;
  // A roll in [0, 1) that picks the MELEE flavor line.
  flavorRoll: number;
  onClose: () => void;
}) {
  const { mode, preset, flavorRoll, onClose } = props;
  const config = PRESETS[preset];

  // Three fleets show only their delta from the two-fleet ruleset: table rules, plus the
  // four specials where the ruleset arms them.
  const openWater = mode === 'open';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fleetLine = FLEET.map((s) => `${SHIP_LABEL[s.kind]} ${s.length}`).join(' · ');
  const actions: { name: string; ap: number; desc: string }[] = [
    {
      name: 'FIRE',
      ap: AP_COST.FIRE,
      desc:
        'Fire at a cell → HIT / MISS / SUNK (class revealed on sunk). ' +
        'Markers belong to CELLS, not ships — if a ship later slides away, your old marker stays and lies.',
    },
    {
      name: 'PING',
      ap: AP_COST.PING,
      desc:
        '3×3 sonar sweep centered on the chosen cell (clips at edges) → one answer: CONTACT or CLEAR. ' +
        'Only un-hit ship cells and live decoys echo — wrecks and cells you already hit read CLEAR, so a contact is always news. ' +
        'Results age visibly on your board.',
    },
    {
      name: 'MOVE',
      ap: AP_COST.MOVE,
      desc:
        'Slide one of YOUR ships 1 cell N/S/E/W into clear water; it keeps its orientation. ' +
        'One move per ship per turn, and a ship with ANY damage is pinned forever. ' +
        'Moving leaves a latent WAKE — enemy sonar sweeping the vacated cells on their very next turn dredges them up (marked ≈, separate from CONTACT); after that the water smooths over.',
    },
    {
      name: 'DECOY',
      ap: AP_COST.DECOY,
      desc:
        `Max ${MAX_DECOYS} per game. Place a 1-cell fake on your own grid: it answers sonar like a ship` +
        ', absorbs the first shot on it as a fake HIT, then dies silently — the attacker is never told.',
    },
    {
      name: 'PASS',
      ap: AP_COST.PASS,
      desc: 'End your turn. Unspent AP is forfeit — there is no banking.',
    },
  ];

  // The four specials in hotkey order (5-8); the shared unlock gate is in the section note.
  const specials: { name: string; ap: number; desc: string }[] = [
    {
      name: 'SPRAY',
      ap: toolCost('SPRAY'),
      desc:
        `Four ordinary shells at once in a ${SPRAY_SIZE}×${SPRAY_SIZE} block, the chosen cell ` +
        'its top-left corner, all into ONE enemy grid. A block that empties a fleet stops ' +
        'there — the rest would fall on a wreck.',
    },
    {
      name: 'SCAN',
      ap: toolCost('SCAN'),
      desc:
        `A ${SCAN_SIZE}×${SCAN_SIZE} close look with the chosen cell as its corner, marking ` +
        'EXACTLY which of its cells hold a live ship. Strongest while the board is crowded. ' +
        'Private; a decoy still shows as a ship, and results age like any other sweep.',
    },
    {
      name: 'FORK',
      ap: toolCost('FORK'),
      desc:
        'Names no board: the same cell into EVERY enemy grid at once, each landing as an ' +
        'ordinary shell. It costs what one aimed shell does, so the shell on the other ' +
        'board comes free — best when one cell is live on both. Retires with the third ' +
        'fleet — against a lone rival it is only a FIRE.',
    },
    {
      name: 'ECHO',
      ap: toolCost('ECHO'),
      desc:
        `A ${ECHO_SIZE}×${ECHO_SIZE} sweep anchored at the chosen cell, reporting its ` +
        'OCCUPANCY: how many of its cells hold a live ship (a decoy counts as one). Strongest ' +
        'when few ships are left. PUBLIC: every fleet hears the number, the one you lit ' +
        'included. Retires with the third fleet.',
    },
  ];

  const actionRows = (rows: typeof actions) => (
    <div className="rules-actions">
      {rows.map((a) => (
        <div key={a.name} className="rules-action">
          <span className="rules-action-name">{a.name}</span>
          <span className="rules-action-cost">{a.ap} AP</span>
          <span className="rules-action-desc">{a.desc}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="rules-overlay" onClick={onClose}>
      <div
        className="rules-pane"
        role="dialog"
        aria-label="How to play"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rules-head">
          <span className="micro-label">FIELD MANUAL · FM-01</span>
          <button type="button" className="btn-micro" onClick={onClose}>
            CLOSE [ESC]
          </button>
        </div>
        <h2 className="rules-title">HOW TO PLAY</h2>

        {openWater ? (
          <>
            <p className="rules-lede">
              Everything in {preset} holds. This page is only what changes with a third fleet on
              the water.
            </p>

            <div className="rules-grid">
              <div className="rules-col">
                <div className="rules-section">
                  <div className="micro-label">01 · LAST FLEET AFLOAT</div>
                  <p>
                    Total fucking war. No allies. Drowning does not end the game. Only one fleet
                    leaves. The first kill drops the table to a duel the survivors finish between
                    themselves. Turn order is a fixed round-robin and a destroyed fleet forfeits
                    its turns.
                  </p>
                </div>

                <div className="rules-section">
                  <div className="micro-label">02 · ACTION POINTS</div>
                  <p>
                    {!config.salvoBudget
                      ? 'Still one shot per turn, whichever board you aim it at.'
                      : config.meleeFullAp
                        ? `Everyone gets a full ${AP_CAP} AP every turn while three fleets are up, ships lost or not.`
                        : `AP still equals ships afloat, floored at ${AP_FLOOR}, against two rivals.`}
                    {config.finalDuelFullAp &&
                      ` Once one is destroyed, the two survivors fight every remaining turn at full ${AP_CAP} AP.`}
                  </p>
                </div>

                <div className="rules-section">
                  <div className="micro-label">03 · PUBLIC FIRE</div>
                  <p>
                    <span className="rules-em">Every shot is public</span>: who fired, at which
                    board, where it landed, and what it did.
                    {config.pings &&
                      ' Pings, moves and decoys stay private. A decoy that eats a shell is logged' +
                        ' as hull damage. Sonar names one fleet per sweep.'}
                  </p>
                </div>
              </div>

              {config.specialTools && (
                <div className="rules-section">
                  <div className="micro-label">04 · SPECIAL TOOLS</div>
                  <p>
                    The locker opens the moment you lose your first ship. Each tool is then
                    reusable, but sits out {TOOL_COOLDOWN} of your turns after every use.
                  </p>
                  {actionRows(specials)}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="rules-lede">
              You know the classic turn-based naval combat game. FLOTILLA keeps the hidden-fleet
              duel and adds an action economy on top: fleets that maneuver, sonar that exposes
              enemies, and decoys that bait fire. Everything else below is the delta.
            </p>

            <div className="rules-grid">
              <div className="rules-col">
                <div className="rules-section">
                  <div className="micro-label">01 · OBJECTIVE</div>
                  <p>
                    10×10 grid each. Fleet: {fleetLine}. Place horizontal or vertical, no overlap,
                    touching allowed. Sink all five enemy ships to win; {MAX_TURNS} turns is a hard
                    draw.
                  </p>
                </div>

                <div className="rules-section">
                  <div className="micro-label">02 · ACTION POINTS</div>
                  <p>
                    Each turn your AP budget = your unsunk ship count, capped at {AP_CAP}, floored
                    at {AP_FLOOR}. Damage degrades your tempo, but a surviving fleet can always
                    return fire. Spend AP one action at a time — you see each result before
                    choosing the next.
                  </p>
                </div>

                <div className="rules-section">
                  <div className="micro-label">03 · INTEL &amp; DECEPTION</div>
                  <p>
                    You see your own board in full, plus whatever your shots and pings earned. When
                    the enemy pings, moves, or deploys a decoy, you see only{' '}
                    <span className="rules-em">ENEMY ACTIVITY — UNRESOLVED</span>: AP was spent,
                    never on what. A decoy absorbing your shot reports as an ordinary HIT — you
                    will never be told. Trust fresh intel over old; a damaged ship is pinned, so
                    finish what you wound.
                  </p>
                </div>

                <div className="rules-section">
                  <div className="micro-label">04 · RULESETS</div>
                  <p>
                    <span className="rules-em">CLASSIC</span> — one shot per turn, nothing else ·{' '}
                    <span className="rules-em">SALVO</span> — AP budget, shots only ·{' '}
                    <span className="rules-em">FLOTILLA</span> — everything.
                  </p>
                </div>
              </div>

              <div className="rules-section">
                <div className="micro-label">05 · ACTIONS</div>
                {actionRows(actions)}
              </div>
            </div>
          </>
        )}

        <p className="rules-flavor">
          {openWater
            ? `“${OPEN_WATER_FLAVOR[Math.floor(flavorRoll * OPEN_WATER_FLAVOR.length)]}”`
            : '“Every fleetmaster begins by counting the squares he can see. The deep is where ' +
              'you learn to count the ones you cannot...”'}
        </p>
      </div>
    </div>
  );
}
