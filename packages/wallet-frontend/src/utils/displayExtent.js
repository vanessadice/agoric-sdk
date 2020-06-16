import { makeMarshal } from '@agoric/marshal';

const noOp = () => {};
const slotToDisplay = slot => slot;
const { unserialize: display } = makeMarshal(noOp, slotToDisplay);

export const displayExtent = amount => {
  const { brand, extent } = display(amount);
  // TODO: this check should be in boardID terms
  if (brand.petname === 'zoe invite') {
    return `${extent} ${brand.petname}`;
  }
  return `${JSON.stringify(extent)} ${brand.petname}`;
};
