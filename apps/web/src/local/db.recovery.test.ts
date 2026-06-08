import { describe, expect, it } from 'vitest';
import { recoveryKind } from './db.js';

// Each string is an actual error observed in Sentry (cyb-capacitor / cyb-react).
describe('recoveryKind', () => {
  it('classifies hard corruption as "corrupt"', () => {
    expect(recoveryKind(new Error('database disk image is malformed'))).toBe('corrupt');
    expect(recoveryKind(new Error('sqlite3_open_v2'))).toBe('corrupt'); // CYB-CAPACITOR-G
    expect(recoveryKind(new Error('failed compacting tables post alteration'))).toBe('corrupt');
    expect(recoveryKind(new Error('SQLITE_CORRUPT: database disk image is malformed'))).toBe('corrupt');
    expect(recoveryKind(new Error('file is not a database'))).toBe('corrupt');
  });

  it('classifies a torn-down IDB transaction as "txn"', () => {
    // CYB-CAPACITOR-F/K, CYB-REACT-J
    expect(
      recoveryKind(new Error('UnknownError: Attempt to get all index records from database without an in-progress transaction')),
    ).toBe('txn');
    expect(
      recoveryKind(new Error('Attempt to get a record from database without an in-progress transaction')),
    ).toBe('txn');
  });

  it('leaves ordinary errors alone (null)', () => {
    expect(recoveryKind(new Error('no such table: recipes'))).toBeNull();
    expect(recoveryKind(new Error('UNIQUE constraint failed'))).toBeNull();
    expect(recoveryKind(new Error('pull timed out after 45s'))).toBeNull();
    expect(recoveryKind(undefined)).toBeNull();
    expect(recoveryKind('some string')).toBeNull();
  });
});
