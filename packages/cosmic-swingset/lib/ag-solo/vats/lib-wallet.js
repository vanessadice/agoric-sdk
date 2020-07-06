/* global harden */

import { assert, details, q } from '@agoric/assert';
import makeStore from '@agoric/store';
import makeWeakStore from '@agoric/weak-store';
import makeAmountMath from '@agoric/ertp/src/amountMath';

// TODO: move the Table abstraction out of Zoe
import { makeTable, makeValidateProperties } from '@agoric/zoe/src/table';
import { E } from '@agoric/eventual-send';

import { makeMarshal } from '@agoric/marshal';

import makeObservablePurse from './observable';
import { makeDehydrator } from './lib-dehydrate';

// does nothing
const noActionStateChangeHandler = _newState => {};

export async function makeWallet({
  zoe,
  board,
  pursesStateChangeHandler = noActionStateChangeHandler,
  inboxStateChangeHandler = noActionStateChangeHandler,
}) {
  // Create the petname maps so we can dehydrate information sent to
  // the frontend.
  const { makeMapping, dehydrate } = makeDehydrator();
  const purseMapping = makeMapping('purse');
  const brandMapping = makeMapping('brand');

  // Brand Table
  // Columns: key:brand | issuer | amountMath
  const makeBrandTable = () => {
    const validateSomewhat = makeValidateProperties(
      harden(['brand', 'issuer', 'amountMath']),
    );

    const issuersInProgress = makeStore();
    const issuerToBrand = makeWeakStore();
    const makeCustomProperties = table =>
      harden({
        addIssuer: issuerP => {
          return Promise.resolve(issuerP).then(issuer => {
            assert(
              !table.has(issuer),
              details`issuer ${issuer} is already in wallet`,
            );
            if (issuersInProgress.has(issuer)) {
              // a promise which resolves to the issuer record
              return issuersInProgress.get(issuer);
            }
            // remote calls which immediately return a promise
            const mathHelpersNameP = E(issuer).getMathHelpersName();
            const brandP = E(issuer).getBrand();

            // a promise for a synchronously accessible record
            const synchronousRecordP = Promise.all([
              brandP,
              mathHelpersNameP,
            ]).then(([brand, mathHelpersName]) => {
              const amountMath = makeAmountMath(brand, mathHelpersName);
              const issuerRecord = {
                issuer,
                brand,
                amountMath,
              };
              table.create(issuerRecord, brand);
              issuerToBrand.init(issuer, brand);
              issuersInProgress.delete(issuer);
              return table.get(brand);
            });
            issuersInProgress.init(issuer, synchronousRecordP);
            return synchronousRecordP;
          });
        },
        getBrandForIssuer: issuerToBrand.get,
      });
    const brandTable = makeTable(validateSomewhat, makeCustomProperties);
    return brandTable;
  };

  const brandTable = makeBrandTable();
  const purseToBrand = makeWeakStore();
  const brandToDepositFacetId = makeWeakStore();

  // Offers that the wallet knows about (the inbox).
  const idToOffer = makeStore();
  const idToNotifierP = makeStore();

  // Compiled offers (all ready to execute).
  const idToCompiledOfferP = new Map();
  const idToComplete = new Map();
  const idToOfferHandle = new Map();
  const idToOutcome = new Map();

  // Client-side representation of the purses inbox;
  const pursesState = new Map();
  const inboxState = new Map();

  // The default Zoe invite purse is used to make an offer.
  let zoeInvitePurse;

  function getSortedValues(map) {
    const entries = [...map.entries()];
    // Sort for determinism.
    const values = entries
      .sort(([id1], [id2]) => id1 > id2)
      .map(([_id, value]) => value);

    return JSON.stringify(values);
  }

  function getPursesState() {
    return getSortedValues(pursesState);
  }

  function getInboxState() {
    return getSortedValues(inboxState);
  }

  const noOp = () => {};
  const identityFn = slot => slot;
  // Instead of { body, slots }, fill the slots. This is useful for
  // display but not for data processing, since the special identifier
  // @qclass is lost.
  const { unserialize: fillInSlots } = makeMarshal(noOp, identityFn);

  async function updatePursesState(pursePetname, purse) {
    const currentAmount = await E(purse).getCurrentAmount();
    const { extent, brand } = currentAmount;
    const brandPetname = brandMapping.valToPetname.get(brand);
    const dehydratedCurrentAmount = dehydrate(currentAmount);
    const brandBoardId = await E(board).getId(brand);
    pursesState.set(pursePetname, {
      brandBoardId,
      brandPetname,
      pursePetname,
      extent,
      currentAmountSlots: dehydratedCurrentAmount,
      currentAmount: fillInSlots(dehydratedCurrentAmount),
    });
    pursesStateChangeHandler(getPursesState());
  }

  async function updateInboxState(id, offer) {
    // Only sent the uncompiled offer to the client.
    inboxState.set(id, offer);
    inboxStateChangeHandler(getInboxState());
  }

  // handle the update, which has already resolved to a record. If the offer is
  // 'done', mark the offer 'complete', otherwise resubscribe to the notifier.
  function updateOrResubscribe(id, offerHandle, update) {
    const { updateHandle, done } = update;
    if (done) {
      // TODO do we still need these?
      idToOfferHandle.delete(id);

      const offer = idToOffer.get(id);
      const completedOffer = {
        ...offer,
        status: 'complete',
      };
      idToOffer.set(id, completedOffer);
      updateInboxState(id, completedOffer);
      idToNotifierP.delete(id);
    } else {
      E(idToNotifierP.get(id))
        .getUpdateSince(updateHandle)
        .then(nextUpdate => updateOrResubscribe(id, offerHandle, nextUpdate));
    }
  }

  // There's a new offer. Ask Zoe to notify us when the offer is complete.
  async function subscribeToNotifier(id, offerHandle) {
    E(zoe)
      .getOfferNotifier(offerHandle)
      .then(offerNotifierP => {
        if (!idToNotifierP.has(id)) {
          idToNotifierP.init(id, offerNotifierP);
        }
        E(offerNotifierP)
          .getUpdateSince()
          .then(update => updateOrResubscribe(id, offerHandle, update));
      });
  }

  async function executeOffer(compiledOfferP) {
    // =====================
    // === AWAITING TURN ===
    // =====================

    const { inviteP, purseKeywordRecord, proposal } = await compiledOfferP;

    // =====================
    // === AWAITING TURN ===
    // =====================

    const invite = await inviteP;

    // We now have everything we need to provide Zoe, so do the actual withdrawal.
    // Payments are made for the keywords in proposal.give.
    const keywords = [];

    const paymentPs = Object.entries(proposal.give || {}).map(
      ([keyword, amount]) => {
        const purse = purseKeywordRecord[keyword];
        assert(
          purse !== undefined,
          details`purse was not found for keyword ${q(keyword)}`,
        );
        keywords.push(keyword);
        return E(purse).withdraw(amount);
      },
    );

    // =====================
    // === AWAITING TURN ===
    // =====================

    const payments = await Promise.all(paymentPs);

    const paymentKeywordRecord = Object.fromEntries(
      keywords.map((keyword, i) => [keyword, payments[i]]),
    );

    // =====================
    // === AWAITING TURN ===
    // =====================

    const {
      payout: payoutObjP,
      completeObj,
      outcome: outcomeP,
      offerHandle: offerHandleP,
    } = await E(zoe).offer(
      invite,
      harden(proposal),
      harden(paymentKeywordRecord),
    );

    // =====================
    // === AWAITING TURN ===
    // =====================
    // This settles when the payments are escrowed in Zoe
    const offerHandle = await offerHandleP;

    // =====================
    // === AWAITING TURN ===
    // =====================
    // This settles when the offer hook completes.
    const outcome = await outcomeP;

    // We'll resolve when deposited.
    const depositedP = payoutObjP.then(payoutObj => {
      const payoutIndexToKeyword = [];
      return Promise.all(
        Object.entries(payoutObj).map(([keyword, payoutP], i) => {
          // keyword may be an index for zoeKind === 'indexed', but we can still treat it
          // as the keyword name for looking up purses and payouts (just happens to
          // be an integer).
          payoutIndexToKeyword[i] = keyword;
          return payoutP;
        }),
      ).then(payoutArray =>
        Promise.all(
          payoutArray.map(async (payoutP, payoutIndex) => {
            const keyword = payoutIndexToKeyword[payoutIndex];
            const purse = purseKeywordRecord[keyword];
            if (purse && payoutP) {
              const payout = await payoutP;
              return E(purse).deposit(payout);
            }
            return undefined;
          }),
        ),
      );
    });

    return { depositedP, completeObj, outcome, offerHandle };
  }

  // === API

  const addIssuer = async (petnameForBrand, issuer) => {
    const issuerSavedP = brandTable.addIssuer(issuer);
    const addBrandPetname = ({ brand }) => {
      brandMapping.addPetname(petnameForBrand, brand);
      return `issuer ${q(petnameForBrand)} successfully added to wallet`;
    };
    return issuerSavedP.then(addBrandPetname);
  };

  const makeEmptyPurse = async (brandPetname, petnameForPurse) => {
    assert(
      !purseMapping.petnameToVal.has(petnameForPurse),
      details`Purse petname ${q(petnameForPurse)} already used in wallet.`,
    );
    const brand = brandMapping.petnameToVal.get(brandPetname);
    const { issuer } = brandTable.get(brand);

    // IMPORTANT: once wrapped, the original purse should never
    // be used otherwise the UI state will be out of sync.
    const doNotUse = await E(issuer).makeEmptyPurse();

    const purse = makeObservablePurse(E, doNotUse, () =>
      updatePursesState(petnameForPurse, doNotUse),
    );

    purseToBrand.init(purse, brand);
    purseMapping.addPetname(petnameForPurse, purse);
    updatePursesState(petnameForPurse, purse);
  };

  function deposit(pursePetname, payment) {
    const purse = purseMapping.petnameToVal.get(pursePetname);
    return purse.deposit(payment);
  }

  function getPurses() {
    return purseMapping.petnameToVal.entries();
  }

  function getPurse(pursePetname) {
    return purseMapping.petnameToVal.get(pursePetname);
  }

  function getPurseIssuer(pursePetname) {
    const purse = purseMapping.petnameToVal.get(pursePetname);
    const brand = purseToBrand.get(purse);
    const { issuer } = brandTable.get(brand);
    return issuer;
  }

  function getOffers({ origin = null } = {}) {
    // return the offers sorted by id
    return idToOffer
      .entries()
      .filter(
        ([_id, offer]) =>
          origin === null ||
          (offer.requestContext && offer.requestContext.origin === origin),
      )
      .sort(([id1], [id2]) => id1 > id2)
      .map(([_id, offer]) => harden(offer));
  }

  const compileProposal = proposalTemplate => {
    const {
      want = {},
      give = {},
      exit = { onDemand: null },
    } = proposalTemplate;

    const purseKeywordRecord = {};

    const compile = amountKeywordRecord => {
      return Object.fromEntries(
        Object.entries(amountKeywordRecord).map(
          ([keyword, { pursePetname, extent }]) => {
            const purse = getPurse(pursePetname);
            purseKeywordRecord[keyword] = purse;
            const brand = purseToBrand.get(purse);
            const amount = { brand, extent };
            return [keyword, amount];
          },
        ),
      );
    };

    const proposal = {
      want: compile(want),
      give: compile(give),
      exit,
    };

    return { proposal, purseKeywordRecord };
  };

  const display = value => fillInSlots(dehydrate(harden(value)));

  const displayProposal = proposalTemplate => {
    const {
      want = {},
      give = {},
      exit = { onDemand: null },
    } = proposalTemplate;
    const compile = pursePetnameExtentKeywordRecord => {
      return Object.fromEntries(
        Object.entries(pursePetnameExtentKeywordRecord).map(
          ([keyword, { pursePetname, extent }]) => {
            const purse = getPurse(pursePetname);
            const brand = purseToBrand.get(purse);
            const amount = { brand, extent };
            return [keyword, { pursePetname, amount: display(amount) }];
          },
        ),
      );
    };
    const proposal = {
      want: compile(want),
      give: compile(give),
      exit,
    };
    return proposal;
  };

  const compileOffer = async offer => {
    const { inviteHandleBoardId } = offer;
    const { proposal, purseKeywordRecord } = compileProposal(
      offer.proposalTemplate,
    );

    // Find invite in wallet and withdraw
    const { extent: inviteExtentElems } = await E(
      zoeInvitePurse,
    ).getCurrentAmount();
    const inviteHandle = await E(board).getValue(inviteHandleBoardId);
    const matchInvite = element => element.handle === inviteHandle;
    const inviteBrand = purseToBrand.get(zoeInvitePurse);
    const { amountMath: inviteAmountMath } = brandTable.get(inviteBrand);
    const inviteAmount = inviteAmountMath.make(
      harden([inviteExtentElems.find(matchInvite)]),
    );
    const inviteP = E(zoeInvitePurse).withdraw(inviteAmount);

    return { proposal, inviteP, purseKeywordRecord };
  };

  async function addOffer(rawOffer, requestContext = { origin: 'unknown' }) {
    const {
      id: rawId,
      instanceHandleBoardId,
      installationHandleBoardId,
      proposalTemplate,
    } = rawOffer;
    const id = `${requestContext.origin}#${rawId}`;
    assert(
      typeof instanceHandleBoardId === 'string',
      details`instanceHandleBoardId must be a string`,
    );
    assert(
      typeof installationHandleBoardId === 'string',
      details`installationHandleBoardId must be a string`,
    );
    const instanceHandle = await E(board).getValue(instanceHandleBoardId);
    const installationHandle = await E(board).getValue(
      installationHandleBoardId,
    );
    const offer = harden({
      ...rawOffer,
      id,
      requestContext,
      status: undefined,
      instancePetname: display(instanceHandle).petname,
      installationPetname: display(installationHandle).petname,
      proposalForDisplay: displayProposal(proposalTemplate),
    });
    idToOffer.init(id, offer);
    updateInboxState(id, offer);

    // Start compiling the template, saving a promise for it.
    idToCompiledOfferP.set(id, compileOffer(offer));

    // Our inbox state may have an enriched offer.
    updateInboxState(id, idToOffer.get(id));
    return id;
  }

  function declineOffer(id) {
    const offer = idToOffer.get(id);
    // Update status, drop the proposal
    const declinedOffer = {
      ...offer,
      status: 'decline',
    };
    idToOffer.set(id, declinedOffer);
    updateInboxState(id, declinedOffer);
  }

  async function cancelOffer(id) {
    const completeFn = idToComplete.get(id);
    if (!completeFn) {
      return false;
    }

    completeFn()
      .then(_ => {
        const offer = idToOffer.get(id);
        const cancelledOffer = {
          ...offer,
          status: 'cancel',
        };
        idToOffer.set(id, cancelledOffer);
        updateInboxState(id, cancelledOffer);
      })
      .catch(e => console.error(`Cannot cancel offer ${id}:`, e));

    return true;
  }

  async function acceptOffer(id) {
    let ret = {};
    let alreadyResolved = false;
    const offer = idToOffer.get(id);
    const rejected = e => {
      if (alreadyResolved) {
        return;
      }
      const rejectOffer = {
        ...offer,
        status: 'rejected',
        error: `${e}`,
      };
      idToOffer.set(id, rejectOffer);
      updateInboxState(id, rejectOffer);
    };

    try {
      const pendingOffer = {
        ...offer,
        status: 'pending',
      };
      idToOffer.set(id, pendingOffer);
      updateInboxState(id, pendingOffer);
      const compiledOffer = await idToCompiledOfferP.get(id);

      const {
        depositedP,
        completeObj,
        outcome,
        offerHandle,
      } = await executeOffer(compiledOffer);

      idToComplete.set(id, () => {
        alreadyResolved = true;
        return E(completeObj).complete();
      });
      idToOfferHandle.set(id, offerHandle);
      // The offer might have been postponed, or it might have been immediately
      // consummated. Only subscribe if it was postponed.
      E(zoe)
        .isOfferActive(offerHandle)
        .then(active => {
          if (active) {
            subscribeToNotifier(id, offerHandle);
          }
        });

      // The outcome is most often a string that can be returned, but
      // it could be an object. We don't do anything currently if it
      // is an object, but we will store it here for future use.
      idToOutcome.set(id, outcome);

      ret = { outcome, depositedP };

      // Update status, drop the proposal
      depositedP
        .then(_ => {
          // We got something back, so no longer pending or rejected.
          if (!alreadyResolved) {
            alreadyResolved = true;
            const acceptedOffer = {
              ...pendingOffer,
              status: 'accept',
            };
            idToOffer.set(id, acceptedOffer);
            updateInboxState(id, acceptedOffer);
          }
        })
        .catch(rejected);
    } catch (e) {
      console.error('Have error', e);
      rejected(e);
      throw e;
    }
    return ret;
  }

  function getIssuers() {
    return brandMapping.petnameToVal.entries().map(([petname, brand]) => {
      const { issuer } = brandTable.get(brand);
      return [petname, issuer];
    });
  }

  function getDepositFacetId(brandBoardId) {
    return E(board)
      .getValue(brandBoardId)
      .then(brand => {
        const depositFacetBoardId = brandToDepositFacetId.get(brand);
        return depositFacetBoardId;
      });
  }

  function addDepositFacet(pursePetname) {
    const purse = purseMapping.petnameToVal.get(pursePetname);
    const pinDepositFacet = depositFacet => E(board).getId(depositFacet);
    const saveAsDefault = boardId => {
      // Add as default unless a default already exists
      const brand = purseToBrand.get(purse);
      if (!brandToDepositFacetId.has(brand)) {
        brandToDepositFacetId.init(brand, boardId);
      }
      return boardId;
    };
    return E(purse)
      .makeDepositFacet()
      .then(pinDepositFacet)
      .then(saveAsDefault);
  }

  const wallet = harden({
    addIssuer,
    makeEmptyPurse,
    deposit,
    getIssuers,
    getPurses,
    getPurse,
    getPurseIssuer,
    addOffer,
    declineOffer,
    cancelOffer,
    acceptOffer,
    getOffers,
    getOfferHandle: id => idToOfferHandle.get(id),
    getOfferHandles: ids => ids.map(wallet.getOfferHandle),
    addDepositFacet,
    getDepositFacetId,
  });

  // Make Zoe invite purse
  const ZOE_INVITE_BRAND_PETNAME = 'zoe invite';
  const ZOE_INVITE_PURSE_PETNAME = 'Default Zoe invite purse';
  const inviteIssuerP = E(zoe).getInviteIssuer();
  const addZoeIssuer = issuerP =>
    wallet.addIssuer(ZOE_INVITE_BRAND_PETNAME, issuerP);
  const makeInvitePurse = () =>
    wallet.makeEmptyPurse(ZOE_INVITE_BRAND_PETNAME, ZOE_INVITE_PURSE_PETNAME);
  const addInviteDepositFacet = () =>
    E(wallet).addDepositFacet(ZOE_INVITE_PURSE_PETNAME);
  await addZoeIssuer(inviteIssuerP)
    .then(makeInvitePurse)
    .then(addInviteDepositFacet);
  zoeInvitePurse = wallet.getPurse(ZOE_INVITE_PURSE_PETNAME);

  return wallet;
}
