// Source: AGENT_REQUEST.md, authoritative original Take Eleven v1 user rules.
const initial = { stones: 11, player: 'A', phase: 'IN_PROGRESS', winner: null };
const definitions = [
  ['setup', 'setup', 'Exactly 11 stones, player A, IN_PROGRESS, no winner.'],
  ['take', 'action', 'Take an integer 1, 2 or 3 only when enough stones remain.'],
  ['turn', 'turn', 'Alternate A/B after each nonwinning take.'],
  ['terminal', 'victory', 'Taking the last stone wins; finished takes preserve full state.'],
  ['illegal', 'action', 'Illegal and unknown actions preserve full state.'],
  ['reset', 'reset', 'Reset restores the exact initial state.'],
  ['storage', 'persistence', 'Save changed states locally; reload restores progress, victory and reset.'],
  ['controls', 'ui', 'Accessible Take 1/2/3 and Reset; visible stones, player, phase and winner.'],
];
export const rules = {
  schemaVersion: 1,
  game: { id: 'take-eleven', title: 'Take Eleven', edition: 'Original v1', kind: 'original' },
  sources: [{ id: 'user-brief', kind: 'user', reference: 'AGENT_REQUEST.md mission objective and assignment: original Take Eleven v1 authoritative rules.' }],
  rules: definitions.map(([id, category, description]) => ({ id, category, description, status: 'verified', sourceIds: ['user-brief'] })),
  unknowns: [],
  invariants: [{ id: 'rules-preserved', description: 'Pure transitions preserve invalid states, rotate turns and terminate on victory; persistence preserves snapshots.', ruleIds: definitions.map(([id]) => id) }],
  stateModel: { initialState: initial, phases: ['IN_PROGRESS', 'FINISHED'] },
};
const take = amount => ({ type: 'take', amount });
const snapshot = (stones, player, winner = null) => ({ stones, player, winner, phase: winner ? 'FINISHED' : 'IN_PROGRESS' });
const model = (id, actions, states) => ({
  id, description: id, kind: 'model', ruleIds: ['setup', 'take', 'turn', 'terminal', 'illegal', 'reset'], invariantIds: ['rules-preserved'],
  steps: actions.map((action, i) => ({ action, expectedState: states[i] })),
});
const path = '/project-pilots/take-eleven';
const goto = { action: 'goto', path };
const click = selector => ({ action: 'click', selector });
const expect = (selector, value) => ({ action: 'expectText', selector, value });
const ready = expect('#ready', 'Ready to play');
const board = (stones, player, winner = 'None') => [expect('#stones', String(stones)), expect('#player', player), expect('#phase', winner === 'None' ? 'IN_PROGRESS' : 'FINISHED'), expect('#winner', winner)];
export const acceptance = {
  schemaVersion: 1, gameId: 'take-eleven', scenarios: [
    model('a-victory', [{ type: 'unknown' }, take(0), take(3), take(3), take(3), take(1), take(2), take(1), take(1), { type: 'reset' }],
      [initial, initial, snapshot(8,'B'), snapshot(5,'A'), snapshot(2,'B'), snapshot(1,'A'), snapshot(1,'A'), snapshot(0,'A','A'), snapshot(0,'A','A'), initial]),
    model('b-victory', [take(3), take(3), take(3), take(2), take(1), { type: 'reset' }],
      [snapshot(8,'B'), snapshot(5,'A'), snapshot(2,'B'), snapshot(0,'B','B'), snapshot(0,'B','B'), initial]),
    ...[
      ['progress-reload-reset', [goto, ready, ...board(11,'A'), click('#take-1'), ...board(10,'B'), goto, ready, ...board(10,'B'), click('#take-2'), ...board(8,'A'), click('#reset'), ...board(11,'A'), goto, ready, ...board(11,'A')]],
      ['a-win-reload-reset', [goto, ready, click('#take-3'), click('#take-3'), click('#take-3'), ...board(2,'B'), { action: 'expectVisible', selector: '#take-3:disabled' }, click('#take-1'), ...board(1,'A'), { action: 'expectVisible', selector: '#take-2:disabled' }, click('#take-1'), ...board(0,'A','A'), ...[1,2,3].map(n => ({ action: 'expectVisible', selector: `#take-${n}:disabled` })), goto, ready, ...board(0,'A','A'), click('#reset'), goto, ready, ...board(11,'A')]],
      ['b-win-reload-reset', [goto, ready, click('#take-3'), click('#take-3'), click('#take-3'), click('#take-2'), ...board(0,'B','B'), goto, ready, ...board(0,'B','B'), click('#reset'), goto, ready, ...board(11,'A')]],
    ].map(([id, steps]) => ({ id, description: id, kind: 'browser', ruleIds: definitions.map(([id]) => id), invariantIds: ['rules-preserved'], steps })),
  ],
};
