import { type L2Block, retryUntil } from '@aztec/aztec.js';
import { INITIAL_L2_BLOCK_NUM } from '@aztec/constants';
import type { ViemPublicClient } from '@aztec/ethereum';
import { omit } from '@aztec/foundation/collection';
import { EthAddress } from '@aztec/foundation/eth-address';
import type { Signature } from '@aztec/foundation/eth-signature';
import { Fr } from '@aztec/foundation/fields';
import { createLogger } from '@aztec/foundation/log';
import { RunningPromise } from '@aztec/foundation/running-promise';
import { type DateProvider, Timer, elapsed } from '@aztec/foundation/timer';
import type { P2P } from '@aztec/p2p';
import { getDefaultAllowedSetupFunctions } from '@aztec/p2p/msg_validators';
import type { BlockBuilderFactory } from '@aztec/prover-client/block-builder';
import type { PublicProcessorFactory } from '@aztec/simulator/server';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { L2BlockSource } from '@aztec/stdlib/block';
import type { ContractDataSource } from '@aztec/stdlib/contract';
import type { L1RollupConstants } from '@aztec/stdlib/epoch-helpers';
import { Gas } from '@aztec/stdlib/gas';
import {
  type AllowedElement,
  SequencerConfigSchema,
  type WorldStateSynchronizer,
} from '@aztec/stdlib/interfaces/server';
import type { L1ToL2MessageSource } from '@aztec/stdlib/messaging';
import type { BlockProposalOptions } from '@aztec/stdlib/p2p';
import { pickFromSchema } from '@aztec/stdlib/schemas';
import type { L2BlockBuiltStats } from '@aztec/stdlib/stats';
import { MerkleTreeId } from '@aztec/stdlib/trees';
import { ContentCommitment, GlobalVariables, ProposedBlockHeader, Tx, type TxHash } from '@aztec/stdlib/tx';
import {
  Attributes,
  L1Metrics,
  type TelemetryClient,
  type Tracer,
  getTelemetryClient,
  trackSpan,
} from '@aztec/telemetry-client';
import type { ValidatorClient } from '@aztec/validator-client';

import type { GlobalVariableBuilder } from '../global_variable_builder/global_builder.js';
import { type SequencerPublisher, VoteType } from '../publisher/sequencer-publisher.js';
import type { SlasherClient } from '../slasher/slasher_client.js';
import { createValidatorForBlockBuilding } from '../tx_validator/tx_validator_factory.js';
import type { SequencerConfig } from './config.js';
import { SequencerMetrics } from './metrics.js';
import { SequencerTimetable, SequencerTooSlowError } from './timetable.js';
import { SequencerState, orderAttestations } from './utils.js';

export { SequencerState };

type SequencerRollupConstants = Pick<L1RollupConstants, 'ethereumSlotDuration' | 'l1GenesisTime' | 'slotDuration'>;

/**
 * Sequencer client
 * - Wins a period of time to become the sequencer (depending on finalized protocol).
 * - Chooses a set of txs from the tx pool to be in the rollup.
 * - Simulate the rollup of txs.
 * - Adds proof requests to the request pool (not for this milestone).
 * - Receives results to those proofs from the network (repeats as necessary) (not for this milestone).
 * - Publishes L1 tx(s) to the rollup contract via RollupPublisher.
 */
export class Sequencer {
  private runningPromise?: RunningPromise;
  private pollingIntervalMs: number = 1000;
  private maxTxsPerBlock = 32;
  private minTxsPerBlock = 1;
  private maxL1TxInclusionTimeIntoSlot = 0;
  // TODO: zero values should not be allowed for the following 2 values in PROD
  private _coinbase = EthAddress.ZERO;
  private _feeRecipient = AztecAddress.ZERO;
  private state = SequencerState.STOPPED;
  private txPublicSetupAllowList: AllowedElement[] = [];
  private maxBlockSizeInBytes: number = 1024 * 1024;
  private maxBlockGas: Gas = new Gas(100e9, 100e9);
  private metrics: SequencerMetrics;
  private l1Metrics: L1Metrics;
  private isFlushing: boolean = false;

  /** The maximum number of seconds that the sequencer can be into a slot to transition to a particular state. */
  protected timetable!: SequencerTimetable;

  protected enforceTimeTable: boolean = false;

  constructor(
    protected publisher: SequencerPublisher,
    protected validatorClient: ValidatorClient | undefined, // During migration the validator client can be inactive
    protected globalsBuilder: GlobalVariableBuilder,
    protected p2pClient: P2P,
    protected worldState: WorldStateSynchronizer,
    protected slasherClient: SlasherClient,
    protected blockBuilderFactory: BlockBuilderFactory,
    protected l2BlockSource: L2BlockSource,
    protected l1ToL2MessageSource: L1ToL2MessageSource,
    protected publicProcessorFactory: PublicProcessorFactory,
    protected contractDataSource: ContractDataSource,
    protected l1Constants: SequencerRollupConstants,
    protected dateProvider: DateProvider,
    protected config: SequencerConfig = {},
    telemetry: TelemetryClient = getTelemetryClient(),
    protected log = createLogger('sequencer'),
  ) {
    this.metrics = new SequencerMetrics(
      telemetry,
      () => this.state,
      this.config.coinbase ?? this.publisher.getSenderAddress(),
      this.publisher.getRollupContract(),
      'Sequencer',
    );
    this.l1Metrics = new L1Metrics(
      telemetry.getMeter('SequencerL1Metrics'),
      publisher.l1TxUtils.client as unknown as ViemPublicClient,
      [publisher.getSenderAddress()],
    );

    // Register the block builder with the validator client for re-execution
    this.validatorClient?.registerBlockBuilder(this.buildBlockFromProposal.bind(this));

    // Register the slasher on the publisher to fetch slashing payloads
    this.publisher.registerSlashPayloadGetter(this.slasherClient.getSlashPayload.bind(this.slasherClient));
  }

  get tracer(): Tracer {
    return this.metrics.tracer;
  }

  public getValidatorAddress() {
    return this.validatorClient?.getValidatorAddress();
  }

  /**
   * Updates sequencer config.
   * @param config - New parameters.
   */
  public async updateConfig(config: SequencerConfig) {
    this.log.info(
      `Sequencer config set`,
      omit(pickFromSchema(config, SequencerConfigSchema), 'txPublicSetupAllowList'),
    );

    if (config.transactionPollingIntervalMS !== undefined) {
      this.pollingIntervalMs = config.transactionPollingIntervalMS;
    }
    if (config.maxTxsPerBlock !== undefined) {
      this.maxTxsPerBlock = config.maxTxsPerBlock;
    }
    if (config.minTxsPerBlock !== undefined) {
      this.minTxsPerBlock = config.minTxsPerBlock;
    }
    if (config.maxDABlockGas !== undefined) {
      this.maxBlockGas = new Gas(config.maxDABlockGas, this.maxBlockGas.l2Gas);
    }
    if (config.maxL2BlockGas !== undefined) {
      this.maxBlockGas = new Gas(this.maxBlockGas.daGas, config.maxL2BlockGas);
    }
    if (config.coinbase) {
      this._coinbase = config.coinbase;
      this.metrics.setCoinbase(this._coinbase);
    }
    if (config.feeRecipient) {
      this._feeRecipient = config.feeRecipient;
    }
    if (config.txPublicSetupAllowList) {
      this.txPublicSetupAllowList = config.txPublicSetupAllowList;
    } else {
      this.txPublicSetupAllowList = await getDefaultAllowedSetupFunctions();
    }
    if (config.maxBlockSizeInBytes !== undefined) {
      this.maxBlockSizeInBytes = config.maxBlockSizeInBytes;
    }
    if (config.governanceProposerPayload) {
      this.publisher.setGovernancePayload(config.governanceProposerPayload);
    }
    if (config.maxL1TxInclusionTimeIntoSlot !== undefined) {
      this.maxL1TxInclusionTimeIntoSlot = config.maxL1TxInclusionTimeIntoSlot;
    }
    if (config.enforceTimeTable !== undefined) {
      this.enforceTimeTable = config.enforceTimeTable;
    }

    this.setTimeTable();

    // TODO: Just read everything from the config object as needed instead of copying everything into local vars.
    this.config = config;
  }

  private setTimeTable() {
    this.timetable = new SequencerTimetable(
      this.l1Constants.ethereumSlotDuration,
      this.aztecSlotDuration,
      this.maxL1TxInclusionTimeIntoSlot,
      this.enforceTimeTable,
      this.metrics,
      this.log,
    );
    this.log.verbose(`Sequencer timetable updated`, { enforceTimeTable: this.enforceTimeTable });
  }

  /**
   * Starts the sequencer and moves to IDLE state.
   */
  public async start() {
    await this.updateConfig(this.config);
    this.metrics.start();
    this.runningPromise = new RunningPromise(this.work.bind(this), this.log, this.pollingIntervalMs);
    this.setState(SequencerState.IDLE, 0n, true /** force */);
    this.runningPromise.start();
    this.l1Metrics.start();
    this.log.info(`Sequencer started with address ${this.publisher.getSenderAddress().toString()}`);
  }

  /**
   * Stops the sequencer from processing txs and moves to STOPPED state.
   */
  public async stop(): Promise<void> {
    this.log.debug(`Stopping sequencer`);
    this.metrics.stop();
    await this.validatorClient?.stop();
    await this.runningPromise?.stop();
    this.slasherClient.stop();
    this.publisher.interrupt();
    this.setState(SequencerState.STOPPED, 0n, true /** force */);
    this.l1Metrics.stop();
    this.log.info('Stopped sequencer');
  }

  /**
   * Starts a previously stopped sequencer.
   */
  public restart() {
    this.log.info('Restarting sequencer');
    this.publisher.restart();
    this.runningPromise!.start();
    this.setState(SequencerState.IDLE, 0n, true /** force */);
  }

  /**
   * Returns the current state of the sequencer.
   * @returns An object with a state entry with one of SequencerState.
   */
  public status() {
    return { state: this.state };
  }

  /** Forces the sequencer to bypass all time and tx count checks for the next block and build anyway. */
  public flush() {
    this.isFlushing = true;
  }

  /**
   * @notice  Performs most of the sequencer duties:
   *          - Checks if we are up to date
   *          - If we are and we are the sequencer, collect txs and build a block
   *          - Collect attestations for the block
   *          - Submit block
   *          - If our block for some reason is not included, revert the state
   */
  protected async doRealWork() {
    this.setState(SequencerState.SYNCHRONIZING, 0n);
    // Update state when the previous block has been synced
    const chainTip = await this.getChainTip();
    // Do not go forward with new block if the previous one has not been mined and processed
    if (!chainTip) {
      return;
    }

    this.setState(SequencerState.PROPOSER_CHECK, 0n);

    const newBlockNumber = chainTip.blockNumber + 1;

    // If we cannot find a tip archive, assume genesis.
    const chainTipArchive = chainTip.archive;

    const slot = await this.slotForProposal(chainTipArchive.toBuffer(), BigInt(newBlockNumber));
    this.metrics.observeSlotChange(slot, this.publisher.getSenderAddress().toString());
    if (!slot) {
      this.log.debug(`Cannot propose block ${newBlockNumber}`);
      return;
    }

    this.log.debug(`Can propose block ${newBlockNumber} at slot ${slot}`);

    const newGlobalVariables = await this.globalsBuilder.buildGlobalVariables(
      new Fr(newBlockNumber),
      this._coinbase,
      this._feeRecipient,
      slot,
    );

    const enqueueGovernanceVotePromise = this.publisher.enqueueCastVote(
      slot,
      newGlobalVariables.timestamp.toBigInt(),
      VoteType.GOVERNANCE,
    );
    const enqueueSlashingVotePromise = this.publisher.enqueueCastVote(
      slot,
      newGlobalVariables.timestamp.toBigInt(),
      VoteType.SLASHING,
    );

    this.setState(SequencerState.INITIALIZING_PROPOSAL, slot);
    this.log.debug(`Preparing proposal for block ${newBlockNumber} at slot ${slot}`, {
      chainTipArchive,
      blockNumber: newBlockNumber,
      slot,
    });

    // If I created a "partial" header here that should make our job much easier.
    const proposalHeader = ProposedBlockHeader.from({
      ...newGlobalVariables,
      timestamp: newGlobalVariables.timestamp.toBigInt(),
      lastArchiveRoot: chainTipArchive,
      contentCommitment: ContentCommitment.empty(),
      totalManaUsed: Fr.ZERO,
    });

    let finishedFlushing = false;
    const pendingTxCount = await this.p2pClient.getPendingTxCount();
    if (pendingTxCount >= this.minTxsPerBlock || this.isFlushing) {
      // We don't fetch exactly maxTxsPerBlock txs here because we may not need all of them if we hit a limit before,
      // and also we may need to fetch more if we don't have enough valid txs.
      const pendingTxs = this.p2pClient.iteratePendingTxs();

      await this.buildBlockAndEnqueuePublish(pendingTxs, proposalHeader, newGlobalVariables).catch(err => {
        this.log.error(`Error building/enqueuing block`, err, { blockNumber: newBlockNumber, slot });
      });
      finishedFlushing = true;
    } else {
      this.log.verbose(
        `Not enough txs to build block ${newBlockNumber} at slot ${slot} (got ${pendingTxCount} txs, need ${this.minTxsPerBlock})`,
        { chainTipArchive, blockNumber: newBlockNumber, slot },
      );
    }

    await enqueueGovernanceVotePromise.catch(err => {
      this.log.error(`Error enqueuing governance vote`, err, { blockNumber: newBlockNumber, slot });
    });
    await enqueueSlashingVotePromise.catch(err => {
      this.log.error(`Error enqueuing slashing vote`, err, { blockNumber: newBlockNumber, slot });
    });

    const resp = await this.publisher.sendRequests();
    if (resp) {
      const proposedBlock = resp.validActions.find(a => a === 'propose');
      if (proposedBlock) {
        this.metrics.incFilledSlot(this.publisher.getSenderAddress().toString());
      }
    }

    if (finishedFlushing) {
      this.isFlushing = false;
    }

    this.setState(SequencerState.IDLE, 0n);
  }

  @trackSpan('Sequencer.work')
  protected async work() {
    try {
      await this.doRealWork();
    } catch (err) {
      if (err instanceof SequencerTooSlowError) {
        this.log.warn(err.message);
      } else {
        // Re-throw other errors
        throw err;
      }
    } finally {
      this.setState(SequencerState.IDLE, 0n);
    }
  }

  public getForwarderAddress() {
    return this.publisher.getForwarderAddress();
  }

  /**
   * Checks if we can propose at the next block and returns the slot number if we can.
   * @param tipArchive - The archive of the previous block.
   * @param proposalBlockNumber - The block number of the proposal.
   * @returns The slot number if we can propose at the next block, otherwise undefined.
   */
  async slotForProposal(tipArchive: Buffer, proposalBlockNumber: bigint): Promise<bigint | undefined> {
    const result = await this.publisher.canProposeAtNextEthBlock(tipArchive);

    if (!result) {
      return undefined;
    }

    const [slot, blockNumber] = result;

    if (proposalBlockNumber !== blockNumber) {
      const msg = `Sequencer block number mismatch. Expected ${proposalBlockNumber} but got ${blockNumber}.`;
      this.log.warn(msg);
      throw new Error(msg);
    }
    return slot;
  }

  /**
   * Sets the sequencer state and checks if we have enough time left in the slot to transition to the new state.
   * @param proposedState - The new state to transition to.
   * @param currentSlotNumber - The current slot number.
   * @param force - Whether to force the transition even if the sequencer is stopped.
   *
   * @dev If the `currentSlotNumber` doesn't matter (e.g. transitioning to IDLE), pass in `0n`;
   * it is only used to check if we have enough time left in the slot to transition to the new state.
   */
  setState(proposedState: SequencerState, currentSlotNumber: bigint, force: boolean = false) {
    if (this.state === SequencerState.STOPPED && force !== true) {
      this.log.warn(`Cannot set sequencer from ${this.state} to ${proposedState} as it is stopped.`);
      return;
    }
    const secondsIntoSlot = this.getSecondsIntoSlot(currentSlotNumber);
    this.timetable.assertTimeLeft(proposedState, secondsIntoSlot);
    this.log.debug(`Transitioning from ${this.state} to ${proposedState}`);
    this.state = proposedState;
  }

  /**
   * Build a block
   *
   * @param pendingTxs - The pending transactions to construct the block from
   * @param newGlobalVariables - The global variables for the new block
   * @param opts - Whether to just validate the block as a validator, as opposed to building it as a proposal
   */
  protected async buildBlock(
    pendingTxs: Iterable<Tx> | AsyncIterable<Tx>,
    newGlobalVariables: GlobalVariables,
    opts: { validateOnly?: boolean } = {},
  ) {
    const blockNumber = newGlobalVariables.blockNumber.toNumber();
    const slot = newGlobalVariables.slotNumber.toBigInt();
    this.log.debug(`Requesting L1 to L2 messages from contract for block ${blockNumber}`);
    const l1ToL2Messages = await this.l1ToL2MessageSource.getL1ToL2Messages(BigInt(blockNumber));
    const msgCount = l1ToL2Messages.length;

    this.log.verbose(`Building block ${blockNumber} for slot ${slot}`, {
      slot,
      blockNumber,
      msgCount,
      validator: opts.validateOnly,
    });

    // Sync to the previous block at least. If we cannot sync to that block because the archiver hasn't caught up,
    // we keep retrying until the reexecution deadline. Note that this could only happen when we are a validator,
    // for if we are the proposer, then world-state should already be caught up, as we check this earlier.
    await retryUntil(
      () => this.worldState.syncImmediate(blockNumber - 1, true).then(syncedTo => syncedTo >= blockNumber - 1),
      'sync to previous block',
      this.timetable.getValidatorReexecTimeEnd(),
      0.1,
    );
    this.log.debug(`Synced to previous block ${blockNumber - 1}`);

    // NB: separating the dbs because both should update the state
    const publicProcessorDBFork = await this.worldState.fork(blockNumber - 1);
    const orchestratorDBFork = await this.worldState.fork(blockNumber - 1);

    const previousBlockHeader =
      (await this.l2BlockSource.getBlock(blockNumber - 1))?.header ?? orchestratorDBFork.getInitialHeader();

    try {
      const processor = this.publicProcessorFactory.create(publicProcessorDBFork, newGlobalVariables, true);
      const blockBuildingTimer = new Timer();
      const blockBuilder = this.blockBuilderFactory.create(orchestratorDBFork);
      await blockBuilder.startNewBlock(newGlobalVariables, l1ToL2Messages, previousBlockHeader);

      // Deadline for processing depends on whether we're proposing a block
      const secondsIntoSlot = this.getSecondsIntoSlot(slot);
      const processingEndTimeWithinSlot = opts.validateOnly
        ? this.timetable.getValidatorReexecTimeEnd(secondsIntoSlot)
        : this.timetable.getBlockProposalExecTimeEnd(secondsIntoSlot);

      // Deadline is only set if enforceTimeTable is enabled.
      const deadline = this.enforceTimeTable
        ? new Date((this.getSlotStartTimestamp(slot) + processingEndTimeWithinSlot) * 1000)
        : undefined;

      this.log.verbose(`Processing pending txs`, {
        slot,
        slotStart: new Date(this.getSlotStartTimestamp(slot) * 1000),
        now: new Date(this.dateProvider.now()),
        deadline,
      });

      const validator = createValidatorForBlockBuilding(
        publicProcessorDBFork,
        this.contractDataSource,
        newGlobalVariables,
        this.txPublicSetupAllowList,
      );

      // TODO(#11000): Public processor should just handle processing, one tx at a time. It should be responsibility
      // of the sequencer to update world state and iterate over txs. We should refactor this along with unifying the
      // publicProcessorFork and orchestratorFork, to avoid doing tree insertions twice when building the block.
      const proposerLimits = {
        maxTransactions: this.maxTxsPerBlock,
        maxBlockSize: this.maxBlockSizeInBytes,
        maxBlockGas: this.maxBlockGas,
      };
      const limits = opts.validateOnly ? { deadline } : { deadline, ...proposerLimits };
      const [publicProcessorDuration, [processedTxs, failedTxs, usedTxs]] = await elapsed(() =>
        processor.process(pendingTxs, limits, validator),
      );

      if (!opts.validateOnly && failedTxs.length > 0) {
        const failedTxData = failedTxs.map(fail => fail.tx);
        const failedTxHashes = await Tx.getHashes(failedTxData);
        this.log.verbose(`Dropping failed txs ${failedTxHashes.join(', ')}`);
        await this.p2pClient.deleteTxs(failedTxHashes);
      }

      if (
        !opts.validateOnly && // We check for minTxCount only if we are proposing a block, not if we are validating it
        !this.isFlushing && // And we skip the check when flushing, since we want all pending txs to go out, no matter if too few
        this.minTxsPerBlock !== undefined &&
        processedTxs.length < this.minTxsPerBlock
      ) {
        this.log.warn(
          `Block ${blockNumber} has too few txs to be proposed (got ${processedTxs.length} but required ${this.minTxsPerBlock})`,
          { slot, blockNumber, processedTxCount: processedTxs.length },
        );
        throw new Error(`Block has too few successful txs to be proposed`);
      }

      const start = process.hrtime.bigint();
      await blockBuilder.addTxs(processedTxs);
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1_000;
      this.metrics.recordBlockBuilderTreeInsertions(duration);

      // All real transactions have been added, set the block as full and pad if needed
      const block = await blockBuilder.setBlockCompleted();

      // How much public gas was processed
      const publicGas = processedTxs.reduce((acc, tx) => acc.add(tx.gasUsed.publicGas), Gas.empty());

      return {
        block,
        publicGas,
        publicProcessorDuration,
        numMsgs: l1ToL2Messages.length,
        numTxs: processedTxs.length,
        numFailedTxs: failedTxs.length,
        blockBuildingTimer,
        usedTxs,
      };
    } finally {
      // We create a fresh processor each time to reset any cached state (eg storage writes)
      // We wait a bit to close the forks since the processor may still be working on a dangling tx
      // which was interrupted due to the processingDeadline being hit.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      setTimeout(async () => {
        try {
          await publicProcessorDBFork.close();
          await orchestratorDBFork.close();
        } catch (err) {
          // This can happen if the sequencer is stopped before we hit this timeout.
          this.log.warn(`Error closing forks for block processing`, err);
        }
      }, 5000);
    }
  }

  /**
   * Build a block from a proposal. Used by the validator to re-execute transactions.
   *
   * @param blockNumber - The block number of the proposal.
   * @param header - The header of the proposal.
   * @param pendingTxs - The pending transactions to construct the block from.
   * @param opts - Whether to just validate the block as a validator, as opposed to building it as a proposal.
   */
  async buildBlockFromProposal(
    blockNumber: Fr,
    header: ProposedBlockHeader,
    pendingTxs: Iterable<Tx> | AsyncIterable<Tx>,
    opts: { validateOnly?: boolean } = {},
  ) {
    const { chainId, version } = await this.globalsBuilder.getGlobalConstantVariables();
    const globalVariables = GlobalVariables.from({
      ...header,
      blockNumber,
      timestamp: new Fr(header.timestamp),
      chainId,
      version,
    });
    return await this.buildBlock(pendingTxs, globalVariables, opts);
  }

  /**
   * @notice  Build and propose a block to the chain
   *
   * @dev     MUST throw instead of exiting early to ensure that world-state
   *          is being rolled back if the block is dropped.
   *
   * @param pendingTxs - Iterable of pending transactions to construct the block from
   * @param proposalHeader - The partial header constructed for the proposal
   */
  @trackSpan('Sequencer.buildBlockAndEnqueuePublish', (_validTxs, _proposalHeader, newGlobalVariables) => ({
    [Attributes.BLOCK_NUMBER]: newGlobalVariables.blockNumber.toNumber(),
  }))
  private async buildBlockAndEnqueuePublish(
    pendingTxs: Iterable<Tx> | AsyncIterable<Tx>,
    proposalHeader: ProposedBlockHeader,
    newGlobalVariables: GlobalVariables,
  ): Promise<void> {
    await this.publisher.validateBlockForSubmission(proposalHeader);

    const blockNumber = newGlobalVariables.blockNumber.toNumber();
    const slot = proposalHeader.slotNumber.toBigInt();

    // this.metrics.recordNewBlock(blockNumber, validTxs.length);
    const workTimer = new Timer();
    this.setState(SequencerState.CREATING_BLOCK, slot);

    try {
      const buildBlockRes = await this.buildBlock(pendingTxs, newGlobalVariables);
      const { publicGas, block, publicProcessorDuration, numTxs, numMsgs, blockBuildingTimer, usedTxs } = buildBlockRes;
      this.metrics.recordBuiltBlock(workTimer.ms(), publicGas.l2Gas);

      // TODO(@PhilWindle) We should probably periodically check for things like another
      // block being published before ours instead of just waiting on our block
      await this.publisher.validateBlockForSubmission(block.header.toPropose());

      const blockStats: L2BlockBuiltStats = {
        eventName: 'l2-block-built',
        creator: this.publisher.getSenderAddress().toString(),
        duration: workTimer.ms(),
        publicProcessDuration: publicProcessorDuration,
        rollupCircuitsDuration: blockBuildingTimer.ms(),
        ...block.getStats(),
      };

      const blockHash = await block.hash();
      const txHashes = block.body.txEffects.map(tx => tx.txHash);
      this.log.info(
        `Built block ${block.number} for slot ${slot} with ${numTxs} txs and ${numMsgs} messages. ${
          publicGas.l2Gas / workTimer.s()
        } mana/s`,
        {
          blockHash,
          globalVariables: block.header.globalVariables.toInspect(),
          txHashes,
          ...blockStats,
        },
      );

      this.log.debug('Collecting attestations');
      const stopCollectingAttestationsTimer = this.metrics.startCollectingAttestationsTimer();
      const attestations = await this.collectAttestations(block, usedTxs);
      if (attestations !== undefined) {
        this.log.verbose(`Collected ${attestations.length} attestations`, { blockHash, blockNumber });
      }
      stopCollectingAttestationsTimer();

      return this.enqueuePublishL2Block(block, attestations, txHashes);
    } catch (err) {
      this.metrics.recordFailedBlock();
      throw err;
    }
  }

  @trackSpan('Sequencer.collectAttestations', (block, txHashes) => ({
    [Attributes.BLOCK_NUMBER]: block.number,
    [Attributes.BLOCK_ARCHIVE]: block.archive.toString(),
    [Attributes.BLOCK_TXS_COUNT]: txHashes.length,
  }))
  protected async collectAttestations(block: L2Block, txs: Tx[]): Promise<Signature[] | undefined> {
    // TODO(https://github.com/AztecProtocol/aztec-packages/issues/7962): inefficient to have a round trip in here - this should be cached
    const committee = await this.publisher.getCurrentEpochCommittee();

    if (committee.length === 0) {
      this.log.verbose(`Attesting committee is empty`);
      return undefined;
    } else {
      this.log.debug(`Attesting committee length is ${committee.length}`);
    }

    if (!this.validatorClient) {
      const msg = 'Missing validator client: Cannot collect attestations';
      this.log.error(msg);
      throw new Error(msg);
    }

    const numberOfRequiredAttestations = Math.floor((committee.length * 2) / 3) + 1;
    const slotNumber = block.header.globalVariables.slotNumber.toBigInt();
    this.setState(SequencerState.COLLECTING_ATTESTATIONS, slotNumber);

    this.log.debug('Creating block proposal for validators');
    const blockProposalOptions: BlockProposalOptions = { publishFullTxs: !!this.config.publishTxsWithProposals };
    const proposal = await this.validatorClient.createBlockProposal(
      block.header.globalVariables.blockNumber,
      block.header.toPropose(),
      block.archive.root,
      block.header.state,
      txs,
      blockProposalOptions,
    );
    if (!proposal) {
      const msg = `Failed to create block proposal`;
      throw new Error(msg);
    }

    this.log.debug('Broadcasting block proposal to validators');
    await this.validatorClient.broadcastBlockProposal(proposal);

    const attestationTimeAllowed = this.enforceTimeTable
      ? this.timetable.getMaxAllowedTime(SequencerState.PUBLISHING_BLOCK)!
      : this.aztecSlotDuration;
    const attestationDeadline = new Date(this.dateProvider.now() + attestationTimeAllowed * 1000);
    const attestations = await this.validatorClient.collectAttestations(
      proposal,
      numberOfRequiredAttestations,
      attestationDeadline,
    );

    // note: the smart contract requires that the signatures are provided in the order of the committee
    return orderAttestations(attestations, committee);
  }

  /**
   * Publishes the L2Block to the rollup contract.
   * @param block - The L2Block to be published.
   */
  @trackSpan('Sequencer.enqueuePublishL2Block', block => ({
    [Attributes.BLOCK_NUMBER]: block.number,
  }))
  protected async enqueuePublishL2Block(
    block: L2Block,
    attestations?: Signature[],
    txHashes?: TxHash[],
  ): Promise<void> {
    // Publishes new block to the network and awaits the tx to be mined
    this.setState(SequencerState.PUBLISHING_BLOCK, block.header.globalVariables.slotNumber.toBigInt());

    // Time out tx at the end of the slot
    const slot = block.header.globalVariables.slotNumber.toNumber();
    const txTimeoutAt = new Date((this.getSlotStartTimestamp(slot) + this.aztecSlotDuration) * 1000);

    const enqueued = await this.publisher.enqueueProposeL2Block(block, attestations, txHashes, {
      txTimeoutAt,
    });

    if (!enqueued) {
      throw new Error(`Failed to enqueue publish of block ${block.number}`);
    }
  }

  /**
   * Returns whether all dependencies have caught up.
   * We don't check against the previous block submitted since it may have been reorg'd out.
   * @returns Boolean indicating if our dependencies are synced to the latest block.
   */
  protected async getChainTip(): Promise<{ blockNumber: number; archive: Fr } | undefined> {
    const syncedBlocks = await Promise.all([
      this.worldState.status().then(({ syncSummary }) => ({
        number: syncSummary.latestBlockNumber,
        hash: syncSummary.latestBlockHash,
      })),
      this.l2BlockSource.getL2Tips().then(t => t.latest),
      this.p2pClient.getStatus().then(p2p => p2p.syncedToL2Block),
      this.l1ToL2MessageSource.getL2Tips().then(t => t.latest),
    ] as const);

    const [worldState, l2BlockSource, p2p, l1ToL2MessageSource] = syncedBlocks;

    // The archiver reports 'undefined' hash for the genesis block
    // because it doesn't have access to world state to compute it (facepalm)
    const result =
      l2BlockSource.hash === undefined
        ? worldState.number === 0 && p2p.number === 0 && l1ToL2MessageSource.number === 0
        : worldState.hash === l2BlockSource.hash &&
          p2p.hash === l2BlockSource.hash &&
          l1ToL2MessageSource.hash === l2BlockSource.hash;

    this.log.debug(`Sequencer sync check ${result ? 'succeeded' : 'failed'}`, {
      worldState,
      l2BlockSource,
      p2p,
      l1ToL2MessageSource,
    });

    if (!result) {
      return undefined;
    }

    if (worldState.number >= INITIAL_L2_BLOCK_NUM) {
      const block = await this.l2BlockSource.getBlock(worldState.number);
      if (!block) {
        // this shouldn't really happen because a moment ago we checked that all components were in synch
        return undefined;
      }

      return { blockNumber: block.number, archive: block.archive.root };
    } else {
      const archive = new Fr((await this.worldState.getCommitted().getTreeInfo(MerkleTreeId.ARCHIVE)).root);
      return { blockNumber: INITIAL_L2_BLOCK_NUM - 1, archive };
    }
  }

  private getSlotStartTimestamp(slotNumber: number | bigint): number {
    return Number(this.l1Constants.l1GenesisTime) + Number(slotNumber) * this.l1Constants.slotDuration;
  }

  private getSecondsIntoSlot(slotNumber: number | bigint): number {
    const slotStartTimestamp = this.getSlotStartTimestamp(slotNumber);
    return Number((this.dateProvider.now() / 1000 - slotStartTimestamp).toFixed(3));
  }

  get aztecSlotDuration() {
    return this.l1Constants.slotDuration;
  }

  get coinbase(): EthAddress {
    return this._coinbase;
  }

  get feeRecipient(): AztecAddress {
    return this._feeRecipient;
  }

  get maxL2BlockGas(): number | undefined {
    return this.config.maxL2BlockGas;
  }
}
