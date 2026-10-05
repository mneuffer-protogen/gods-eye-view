import test from 'node:test';
import assert from 'node:assert/strict';
import {
  midFromMmsi,
  flagStateFromMmsi,
  flagStateLabel,
} from './aisIdentity.js';

test('a ship MMSI leads with its MID', () => {
  assert.equal(midFromMmsi('232001234'), '232');
  assert.equal(midFromMmsi(353136000), '353');
  assert.deepEqual(flagStateFromMmsi('353136000'), {
    mid: '353',
    country: 'PANAMA',
    countryCode: 'PA',
  });
  assert.equal(flagStateLabel('229123456'), 'MALTA (MT)');
});

test('other station kinds carry the MID further in', () => {
  assert.equal(midFromMmsi('002320001'), '232', 'coast station');
  assert.equal(midFromMmsi('023200012'), '232', 'group call');
  assert.equal(midFromMmsi('111232001'), '232', 'SAR aircraft');
  assert.equal(midFromMmsi('982321234'), '232', 'craft of a parent ship');
  assert.equal(midFromMmsi('992321234'), '232', 'aid to navigation');
  assert.equal(midFromMmsi('823212345'), '232', 'handheld');
});

test('distress devices, malformed numbers and unknown MIDs read honestly', () => {
  assert.equal(flagStateFromMmsi('972000001'), null, 'AIS-SART has no MID');
  assert.equal(flagStateFromMmsi('12345'), null);
  assert.equal(flagStateFromMmsi('123456789'), null);
  assert.equal(flagStateFromMmsi(''), null);
  assert.equal(flagStateFromMmsi(undefined), null);
  assert.equal(flagStateLabel('799000001'), 'MID 799');
});
