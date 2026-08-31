import { decideEnroll } from './enroll.js';

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const CODE = 'the-real-enroll-code';
/** A budget with `allowed` charges left, counting what it is asked to spend. */
const budget = (allowed: number) => {
  const state = { spent: 0 };
  return {
    state,
    spend: async () => {
      state.spent++;
      return { isAllowed: state.spent <= allowed, ttlInSeconds: 3600 };
    },
  };
};

console.log('\nbootstrap: the enroll code is the only way in');
{
  const b = budget(10);
  check('the correct code is let through',
    await decideEnroll({ bootstrapped: false, authenticated: false, supplied: CODE, expected: CODE, spendFailure: b.spend }),
    { ok: true });
  check('and spends nothing from the failure budget', b.state.spent, 0);
}
{
  const b = budget(10);
  check('a wrong code is refused',
    await decideEnroll({ bootstrapped: false, authenticated: false, supplied: 'nope', expected: CODE, spendFailure: b.spend }),
    { ok: false, code: 403, error: 'bad_enroll_code' });
  check('and costs exactly one charge', b.state.spent, 1);
}

console.log('\nthe budget caps guessing without locking the owner out');
{
  // A stranger burns the whole shared budget.
  const b = budget(3);
  for (let i = 0; i < 3; i++) {
    await decideEnroll({ bootstrapped: false, authenticated: false, supplied: `guess-${i}`, expected: CODE, spendFailure: b.spend });
  }
  check('a further wrong code is rate-limited, not merely refused',
    await decideEnroll({ bootstrapped: false, authenticated: false, supplied: 'guess-4', expected: CODE, spendFailure: b.spend }),
    { ok: false, code: 429, error: 'too_many_enroll_attempts', retryAfter: 3600 });

  // The regression this file exists for: the owner arrives with the real code
  // after a stranger has emptied the bucket. Charging the budget before the
  // code was checked turned this into a remote, unauthenticated lockout of the
  // one documented way back into the archive.
  check('THE OWNER STILL GETS IN with the correct code on an empty budget',
    await decideEnroll({ bootstrapped: false, authenticated: false, supplied: CODE, expected: CODE, spendFailure: b.spend }),
    { ok: true });
}

console.log('\nadding a second device does not touch the code or the budget');
{
  const b = budget(0); // fully exhausted
  check('an authenticated session is enough',
    await decideEnroll({ bootstrapped: true, authenticated: true, supplied: undefined, expected: CODE, spendFailure: b.spend }),
    { ok: true });
  check('even with the budget already empty', b.state.spent, 0);
  check('an unauthenticated caller is refused',
    await decideEnroll({ bootstrapped: true, authenticated: false, supplied: CODE, expected: CODE, spendFailure: b.spend }),
    { ok: false, code: 401, error: 'not_authenticated' });
  check('and a correct code does NOT substitute for a session', b.state.spent, 0);
}

console.log('\nthe code arrives off a JSON body, so it can be anything');
{
  for (const [label, supplied] of [
    ['a number', 42], ['an object', { a: 1 }], ['an array', ['x']],
    ['a boolean', true], ['null', null], ['undefined', undefined],
  ] as [string, unknown][]) {
    const b = budget(10);
    check(`${label} is refused rather than throwing`,
      await decideEnroll({ bootstrapped: false, authenticated: false, supplied, expected: CODE, spendFailure: b.spend }),
      { ok: false, code: 403, error: 'bad_enroll_code' });
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
