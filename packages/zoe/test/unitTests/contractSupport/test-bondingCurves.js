// eslint-disable-next-line import/no-extraneous-dependencies
import '@agoric/install-ses';
import { test } from 'tape-promise/tape';

import {
  getInputPrice,
  calcLiqExtentToMint,
} from '../../../src/contractSupport';

const testGetPrice = (t, input, expectedOutput) => {
  const output = getInputPrice(input);
  t.deepEquals(output, expectedOutput);
};

// If these tests of `getInputPrice` fail, it would indicate that we have
// diverged from the calculation in the Uniswap paper.
test('getInputPrice ok 1', t => {
  t.plan(1);
  try {
    const input = {
      inputReserve: 0,
      outputReserve: 0,
      inputExtent: 1,
    };
    const expectedOutput = 0;
    testGetPrice(t, input, expectedOutput);
  } catch (e) {
    t.assert(false, e);
  }
});

test('getInputPrice ok 2', t => {
  t.plan(1);
  try {
    const input = {
      inputReserve: 5984,
      outputReserve: 3028,
      inputExtent: 1398,
    };
    const expectedOutput = 572;
    testGetPrice(t, input, expectedOutput);
  } catch (e) {
    t.assert(false, e);
  }
});

test('getInputPrice ok 3', t => {
  t.plan(1);
  try {
    const input = {
      inputReserve: 8160,
      outputReserve: 7743,
      inputExtent: 6635,
    };
    const expectedOutput = 3466;
    testGetPrice(t, input, expectedOutput);
  } catch (e) {
    t.assert(false, e);
  }
});

test('getInputPrice reverse x and y amounts', t => {
  t.plan(1);
  try {
    // Note: this is now the same test as the one above because we are
    // only using extents
    const input = {
      inputReserve: 8160,
      outputReserve: 7743,
      inputExtent: 6635,
    };
    const expectedOutput = 3466;
    testGetPrice(t, input, expectedOutput);
  } catch (e) {
    t.assert(false, e);
  }
});

test('getInputPrice ok 4', t => {
  t.plan(1);
  try {
    const input = {
      inputReserve: 10,
      outputReserve: 10,
      inputExtent: 1000,
    };
    const expectedOutput = 9;
    testGetPrice(t, input, expectedOutput);
  } catch (e) {
    t.assert(false, e);
  }
});

test('getInputPrice ok 5', t => {
  t.plan(1);
  try {
    const input = {
      inputReserve: 100,
      outputReserve: 50,
      inputExtent: 17,
    };
    const expectedOutput = 7;
    testGetPrice(t, input, expectedOutput);
  } catch (e) {
    t.assert(false, e);
  }
});

test('getInputPrice ok 6', t => {
  t.plan(1);
  try {
    const input = {
      outputReserve: 117,
      inputReserve: 43,
      inputExtent: 7,
    };
    const expectedOutput = 16;
    testGetPrice(t, input, expectedOutput);
  } catch (e) {
    t.assert(false, e);
  }
});

test('calculate extent to mint - positive supply', t => {
  const res = calcLiqExtentToMint({
    liqTokenSupply: 20,
    inputExtent: 30,
    inputReserve: 5,
  });
  t.equals(res, (20 * 30) / 5, 'When supply is present, floor(x*y/z)');
  t.end();
});

test('calculate extent to mint - mispelled key', t => {
  t.throws(
    () =>
      calcLiqExtentToMint({
        liquidityTokenSupply: 20,
        inputExtent: 30,
        inputReserve: 5,
      }),
    `calcLiqExtentToMint should throw if a key is misspelled`,
  );
  t.end();
});

test('calculate extent to mint - positive supply', t => {
  const res = calcLiqExtentToMint({
    liqTokenSupply: 5,
    inputExtent: 8,
    inputReserve: 7,
  });
  t.equals(res, 5, 'When supply is present, floor(x*y/z)');
  t.end();
});

test('calculate extent to mint - no supply', t => {
  const res = calcLiqExtentToMint({
    liqTokenSupply: 0,
    inputExtent: 30,
    inputReserve: 5,
  });
  t.equals(res, 30, 'When the supply is empty, return inputExtent');
  t.end();
});
