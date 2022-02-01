import { EPSClient } from '../eps'
import { transferSender, transferReceiver, TransferFinalizeData, transferReceiverFinalize, SCEAddress } from "../mercury/transfer"
import { pollUtxo, pollSwap, getSwapInfo, swapRegisterUtxo, swapDeregisterUtxo } from "./info_api";
import { delay, getStateCoin, getTransferBatchStatus } from "../mercury/info_api";
import { StateChainSig } from "../util";
import { BIP32Interface, Network, script, ECPair } from 'bitcoinjs-lib';
import { v4 as uuidv4 } from 'uuid';
import { Wallet } from '../wallet'
import { ACTION } from '../activity_log';
import { encodeSCEAddress, POST_ROUTE, GET_ROUTE, StateCoin, STATECOIN_STATUS } from '..';

import { get_swap_steps } from './swap_steps'
import { BatchData, BlindedSpendSignature, BSTRequestorData, first_message, get_blinded_spend_signature, second_message, SwapID, SwapInfo, SwapPhaseClients, SwapStep, SwapStepResult, SWAP_RETRY, SWAP_STATUS, UI_SWAP_STATUS, validateSwap } from './swap_utils';

let cloneDeep = require('lodash.clonedeep');
let bitcoin = require("bitcoinjs-lib");
let types = require("../types")
let typeforce = require('typeforce');
const version = require("../../../package.json").version;

// Logger import.
// Node friendly importing required for Jest tests.
declare const window: any;
let log: any;
try {
  log = window.require('electron-log');
} catch (e: any) {
  log = require('electron-log');
}


export default class Swap {
  swap_steps: SwapStep[]
  clients: SwapPhaseClients
  wallet: Wallet
  statecoin: StateCoin
  network: Network
  proof_key_der: BIP32Interface
  new_proof_key_der: BIP32Interface
  swap_size: number
  req_confirmations: number
  next_step: number
  block_height: any
  blinded_spend_signature: BlindedSpendSignature | null
  statecoin_out: StateCoin | null
  n_reps: number
  swap0_count: number
  n_retries: number

  constructor(wallet: Wallet,
    statecoin: StateCoin, proof_key_der: BIP32Interface,
    new_proof_key_der: BIP32Interface) {
    this.wallet = wallet
    this.clients = SwapPhaseClients.from_wallet(wallet)
    this.proof_key_der = proof_key_der
    this.new_proof_key_der = new_proof_key_der
    this.statecoin = statecoin
    this.network = wallet.config.network
    this.swap_size = wallet.config.min_anon_set
    this.req_confirmations = wallet.config.required_confirmations
    this.next_step = 0
    this.blinded_spend_signature = null
    this.statecoin_out = null
    this.swap_steps = get_swap_steps(this)
    this.n_reps = 0
    this.swap0_count = 0
    this.n_retries = 0
  }

  setSwapSteps = (steps: SwapStep[]) => {
    this.swap_steps = steps
  }

  getStep = (n: number) => {
    return this.swap_steps[n]
  }

  getNextStep = () => {
    return this.swap_steps[this.next_step]
  }

  checkStatecoinStatus = (step: SwapStep) => {
    if (!step.statecoin_status()) {
      throw Error(`${step.description()}: invalid statecoin status: ${this.statecoin.status}`)
    }
  }

  checkSwapStatus = (step: SwapStep) => {
    if (!step.swap_status()) {
      throw Error(`${step.description()}: invalid swap status: ${this.statecoin.swap_status}`)
    }
  }

  checkStatecoinProperties = (step: SwapStep) => {
    if (!step.statecoin_properties()) {
      throw Error(`${step.description()}: invalid statecoin properties: ${JSON.stringify(this.statecoin)}`)
    }
  }

  checkCurrentStatus = () => {
    let step = this.getNextStep()
    this.checkStatecoinStatus(step)
    this.checkSwapStatus(step)
    this.checkStatecoinProperties(step)
  }

  doNext = async (): Promise<SwapStepResult> => {
    this.checkNReps()
    this.checkSwapLoopStatus()
    this.checkCurrentStatus()
    let step_result = await this.getNextStep().doit()
    if (step_result.is_ok()) {
      this.incrementStep()
      this.incrementCounters()
      this.n_retries = 0
    } else {
      this.incrementRetries(step_result)
      if (step_result.includes("Incompatible")) {
        alert(step_result.message)
      }
      if (step_result.includes("punishment")) {
        alert(step_result.message)
      }
    }
    return step_result
  }

  incrementRetries = (step_result: SwapStepResult) => {
    //Allow unlimited network errors in phase 4
    if (this.statecoin.swap_status === SWAP_STATUS.Phase4) {
      if (!(step_result.message.includes('Network') ||
        step_result.message.includes('network') ||
        step_result.message.includes('net::ERR'))) {
        this.n_retries = this.n_retries + 1
      }
    } else {
      this.n_retries = this.n_retries + 1
    }
  }

  incrementStep = () => {
    this.next_step = this.next_step + 1
  }

  checkNReps = () => {
    if (this.statecoin.swap_status !== SWAP_STATUS.Phase4 && this.n_reps >= SWAP_RETRY.MAX_REPS_PER_PHASE) {
      throw new Error(`Number of tries exceeded in phase ${this.statecoin.swap_status}`)
    }
    if (this.statecoin.swap_status === SWAP_STATUS.Phase4 && this.n_reps >= SWAP_RETRY.MAX_REPS_PHASE4) {
      throw new Error(`Number of tries exceeded in phase ${this.statecoin.swap_status}`)
    }
  }

  checkSwapLoopStatus = async () => {
    let statecoin = this.statecoin
    if (statecoin.status === STATECOIN_STATUS.AVAILABLE) {
      throw new Error("Coin removed from swap pool")
    }
    if (statecoin.swap_status === SWAP_STATUS.Phase0) {
      if (this.swap0_count >= SWAP_RETRY.INIT_RETRY_AFTER) {
        await this.reset()
      }
    }
  }

  reset = async () => {
    let statecoin = this.statecoin
    await swapDeregisterUtxo(this.clients.http_client, { id: statecoin.statechain_id });
    statecoin.setSwapDataToNull();
    statecoin.swap_status = SWAP_STATUS.Init;
    statecoin.setAwaitingSwap();
    this.resetCounters()
  }

  resetCounters = () => {
    this.swap0_count = 0
    this.n_reps = 0
    this.n_retries = 0
    this.next_step = this.get_next_step_from_swap_status()
  }

  get_next_step_from_swap_status = () => {
    let status = this.statecoin.swap_status
    for (let i = 0; i < this.swap_steps.length; i++) {
      let step = this.swap_steps[i]
      if (step.phase === status) {
        return i
      }
    }
    // Reset to initial step by default
    return 0
  }

  incrementCounters = () => {
    const statecoin = this.statecoin
    // Keep trying to join swap indefinitely
    if (statecoin.status === STATECOIN_STATUS.AWAITING_SWAP) {
      this.n_reps = 0
      return
    }
    switch (statecoin.swap_status) {
      case SWAP_STATUS.Phase0: {
        this.swap0_count++;
        return
      }
      default: {
        this.n_reps = this.n_reps + 1
        return
      }
    }
  }


  checkProofKeyDer = (): SwapStepResult => {
    try {
      typeforce(typeforce.compile(typeforce.Buffer), this.proof_key_der?.publicKey);
      typeforce(typeforce.compile(typeforce.Function), this.proof_key_der?.sign);
    } catch (err) {
      throw new Error(`swapInit: proof_key_der type error: ${err}`)
    }
    return SwapStepResult.Ok()
  }

  swapRegisterUtxo = async (): Promise<SwapStepResult> => {
    let publicKey = this.proof_key_der.publicKey.toString('hex');
    let sc_sig = StateChainSig.create(this.proof_key_der, "SWAP", publicKey);

    let registerUtxo = {
      statechain_id: this.statecoin.statechain_id,
      signature: sc_sig,
      swap_size: this.swap_size,
      wallet_version: version.replace("v", "")
    };

    try {
      await swapRegisterUtxo(this.clients.http_client, registerUtxo);
    } catch (err: any) {
      return SwapStepResult.Retry(err.message)
    }

    log.info("Coin registered for Swap. Coin ID: ", this.statecoin.shared_key_id)

    this.statecoin.swap_status = SWAP_STATUS.Phase0;
    this.statecoin.ui_swap_status = UI_SWAP_STATUS.Phase0;
    return SwapStepResult.Ok()
  }


  pollUtxo = async (): Promise<SwapStepResult> => {
    try {
      let swap_id = await pollUtxo(this.clients.http_client,
        { id: this.statecoin.statechain_id });
      if (swap_id.id !== null) {
        log.info("Swap Phase0: Swap ID received: ", swap_id)
        this.updateStateCoinToPhase1(swap_id)
        return SwapStepResult.Ok()
      } else {
        return SwapStepResult.Retry()
      }
    } catch (err: any) {
      return SwapStepResult.Retry(err.message)
    }
  }

  updateStateCoinToPhase1 = async (swap_id: any) => {
    let statecoin = this.statecoin
    statecoin.swap_id = swap_id
    statecoin.swap_status = SWAP_STATUS.Phase1;
    statecoin.ui_swap_status = UI_SWAP_STATUS.Phase1;
  }

  // Poll Conductor awaiting swap info. When it is available carry out phase1 tasks:
  // Return an SCE-Address and produce a signature over the swap_token with the
  //  proof key that currently owns the state chain they are transferring in the swap.
  pollUtxoPhase1 = async (): Promise<SwapStepResult> => {
    //Check swap id again to confirm that the coin is still awaiting swap
    //according to the server
    let swap_id;
    try {
      swap_id = await pollUtxo(this.clients.http_client, { id: this.statecoin.statechain_id });
    } catch (err: any) {
      return SwapStepResult.Retry(err.message)
    }
    this.statecoin.swap_id = swap_id
    if (swap_id == null || swap_id.id == null) {
      throw new Error("In swap phase 1 - no swap ID found");
    }
    return SwapStepResult.Ok()
  }

  getSwapID(): SwapID {
    const swap_id = this.statecoin.swap_id
    if (swap_id === null || swap_id === undefined) {
      throw new Error("expected SwapID, got null or undefined")
    }
    return swap_id
  }

  getStatecoinOut(): StateCoin {
    const statecoin_out = this.statecoin_out
    if (statecoin_out === null || statecoin_out === undefined) {
      throw new Error("expected StateCoin, got null or undefined")
    }
    return statecoin_out
  }


  getBlindedSpendSignature(): BlindedSpendSignature {
    const bss = this.blinded_spend_signature
    if (bss === null || bss === undefined) {
      throw new Error("expected BlindedSpendSignature, got null or undefined")
    }
    return bss
  }

  getBSTRequestorData(): BSTRequestorData {
    const data = this.statecoin.swap_my_bst_data
    if (data === null || data === undefined) {
      throw new Error("expected BSTRequestorData, got null or undefined")
    }
    return data
  }

  loadSwapInfo = async (): Promise<SwapStepResult> => {
    try {
      let swap_info = await getSwapInfo(this.clients.http_client, this.getSwapID());
      if (swap_info === null) {
        return SwapStepResult.Retry("awaiting swap info...")
      }
      typeforce(types.SwapInfo, swap_info);
      this.statecoin.swap_info = swap_info;
      this.statecoin.setInSwap();
      return SwapStepResult.Ok(`swap info received`)
    } catch (err: any) {
      return SwapStepResult.Retry(err.message)
    }
  }

  getBSTData = async (): Promise<SwapStepResult> => {
    let address = {
      "tx_backup_addr": null,
      "proof_key": this.new_proof_key_der.publicKey.toString("hex"),
    };
    typeforce(types.SCEAddress, address);

    let transfer_batch_sig = StateChainSig.new_transfer_batch_sig(this.proof_key_der,
      this.getSwapID().id, this.statecoin.statechain_id);
    try {
      let my_bst_data = await first_message(
        this.clients.http_client,
        await this.wallet.getWasm(),
        this.getSwapInfo(),
        this.statecoin.statechain_id,
        transfer_batch_sig,
        address,
        this.proof_key_der
      );

      // Update coin with address, bst data and update status
      this.statecoin.swap_address = address;
      this.statecoin.swap_my_bst_data = my_bst_data;
      this.statecoin.swap_status = SWAP_STATUS.Phase2;
      this.statecoin.ui_swap_status = UI_SWAP_STATUS.Phase2;
      return SwapStepResult.Ok()
    } catch (err: any) {
      return SwapStepResult.Retry(err.message)
    }
  }


  // Poll swap until phase changes to Phase2. In that case all participants have completed Phase1
  // and swap second message can be performed.
  pollSwapPhase2 = async (): Promise<SwapStepResult> => {
    // Poll swap until phase changes to Phase2.
    let phase = null
    try {
      phase = await pollSwap(this.clients.http_client, this.getSwapID());
    } catch (err: any) {
      return SwapStepResult.Retry(err.message)
    }
    if (phase === SWAP_STATUS.Phase1) {
      return SwapStepResult.Retry("awaiting server phase 2...")
    } else if (phase === null) {
      throw new Error("Swap halted at phase 1");
    } else if (phase !== SWAP_STATUS.Phase2) {
      throw new Error("Swap error: Expected swap phase1 or phase2. Received: " + phase);
    }
    return SwapStepResult.Ok(`Swap Phase2: Coin ${this.statecoin.shared_key_id} + " in Swap ", ${this.statecoin.swap_id}`)
  }

  getBSS = async (): Promise<SwapStepResult> => {
    let bss
    try {
      bss = await get_blinded_spend_signature(this.clients.http_client, this.getSwapID().id, this.statecoin.statechain_id);
      this.statecoin.ui_swap_status = UI_SWAP_STATUS.Phase3;
      this.blinded_spend_signature = bss
      return SwapStepResult.Ok('got blinded spend signature')
    } catch (err: any) {
      return SwapStepResult.Retry(err.message)
    }
  }

  getNewTorID = async (): Promise<SwapStepResult> => {
    try {
      await this.clients.http_client.new_tor_id();
      this.statecoin.ui_swap_status = UI_SWAP_STATUS.Phase4;
    } catch (err: any) {
      return SwapStepResult.Retry(`Error getting new TOR id: ${err}`)
    }
    await delay(1);
    return SwapStepResult.Ok('got new tor ID')
  }

  doSwapSecondMessage = async (): Promise<SwapStepResult> => {
    try {
      let receiver_addr = await second_message(this.clients.http_client, await this.wallet.getWasm(), this.getSwapID().id,
        this.getBSTRequestorData(), this.getBlindedSpendSignature());
      this.statecoin.ui_swap_status = UI_SWAP_STATUS.Phase5;
      // Update coin with receiver_addr and update status
      this.statecoin.swap_receiver_addr = receiver_addr;
      this.statecoin.swap_status = SWAP_STATUS.Phase3;
      return SwapStepResult.Ok(`got receiver address`);
    } catch (err: any) {
      return SwapStepResult.Retry(err.message)
    }
  }

  pollSwapPhase3 = async (): Promise<SwapStepResult> => {
    let phase
    try {
      phase = await pollSwap(this.clients.http_client, this.getSwapID());
    } catch (err: any) {
      return SwapStepResult.Retry(err.message)
    }
    return this.checkServerPhase4(phase)
  }


  checkServerPhase4 = (phase: string): SwapStepResult => {
    if (phase === SWAP_STATUS.Phase4) {
      return SwapStepResult.Ok("server in phase 4")
    } else if (phase == null) {
      throw new Error("Swap halted at phase 3");
    }
    return SwapStepResult.Retry("awaiting server phase 4")
  }

  getSwapReceiverAddr(): SCEAddress {
    const addr = this.statecoin.swap_receiver_addr
    if (addr === null || addr === undefined) {
      throw new Error("expected SCEAddress, got null or undefined")
    }
    return addr
  }

  transferSender = async (): Promise<SwapStepResult> => {
    try {
      // if this part has not yet been called, call it.
      this.statecoin.swap_transfer_msg = await transferSender(this.clients.http_client,
        await this.wallet.getWasm(), this.network, this.statecoin, this.proof_key_der,
        this.getSwapReceiverAddr().proof_key, true, this.wallet);
      this.statecoin.ui_swap_status = UI_SWAP_STATUS.Phase6;
      this.wallet.saveStateCoinsList()
      await delay(SWAP_RETRY.SHORT_DELAY_S);
      return SwapStepResult.Ok("transfer sender complete")
    } catch (err: any) {
      return SwapStepResult.Retry(err.message)
    }
  }

  makeSwapCommitment = async (): Promise<SwapStepResult> => {
    this.statecoin.swap_batch_data = await this.make_swap_commitment();
    this.wallet.saveStateCoinsList()
    return SwapStepResult.Ok("made swap commitment")
  }

  getSwapInfo(): SwapInfo {
    const swap_info = this.statecoin.swap_info
    if (swap_info === null || swap_info === undefined) {
      throw new Error("expected SwapInfo, got null or undefined")
    }
    return swap_info
  }

  make_swap_commitment = async (): Promise<BatchData> => {
    let statecoin = this.statecoin
    let swap_info = this.getSwapInfo()
    let wasm_client = await this.wallet.getWasm()

    let commitment_str: string = statecoin.statechain_id;
    swap_info.swap_token.statechain_ids.forEach(function (item: string) {
      commitment_str.concat(item);
    });
    let batch_data_json: string = wasm_client.Commitment.make_commitment(commitment_str);

    let batch_data: BatchData = JSON.parse(batch_data_json);
    typeforce(types.BatchData, batch_data);
    return batch_data;
  }

  getSwapBatchTransferData(): BatchData {
    const batch_data = this.statecoin.swap_batch_data
    if (batch_data === null || batch_data === undefined) {
      throw new Error("expected SCEAddress, got null or undefined")
    }
    return batch_data
  }

  is_statechain_id_in_swap = (id: string): boolean => {
    return (this.getSwapInfo().swap_token.statechain_ids.indexOf(id) >= 0)
  }
  do_transfer_receiver = async (): Promise<TransferFinalizeData | null> => {
    let http_client = this.clients.http_client
    let electrum_client = this.clients.electrum_client
    let network = this.network
    let batch_id = this.getSwapID().id
    let rec_se_addr_bip32 = this.new_proof_key_der
    let req_confirmations = this.req_confirmations
    let block_height = this.block_height
    let commit = this.getSwapBatchTransferData().commitment
    let value = this.statecoin.value

    let msg3s;
    let n_retries = 0
    const MAX_RETRIES = 10
    while (n_retries < MAX_RETRIES) {
      try {
        msg3s = await http_client.get(GET_ROUTE.TRANSFER_GET_MSG_ADDR, rec_se_addr_bip32.publicKey.toString("hex"));
      } catch (err: any) {
        let message: string | undefined = err?.message
        if (message && !message.includes("DB Error: No data for identifier")) {
          throw err;
        }
        await delay(2);
        n_retries = n_retries + 1
        continue;
      }

      for (let i = 0; i < msg3s.length; i++) {
        let msg3 = cloneDeep(msg3s[i])
        typeforce(types.TransferMsg3, msg3);

        if (this.is_statechain_id_in_swap(msg3.statechain_id)) {
          let batch_data = {
            "id": batch_id,
            "commitment": commit,
          }

          await delay(1);
          let finalize_data = await transferReceiver(http_client, electrum_client, network, msg3, rec_se_addr_bip32, batch_data, req_confirmations, block_height, value);
          typeforce(types.TransferFinalizeData, finalize_data);
          return finalize_data;
        }
      }
    }
    return null;
  }

  updateBlockHeight = async () => {
    if (this.clients.electrum_client instanceof EPSClient) {
      let header = await this.clients.electrum_client.latestBlockHeader();
      this.block_height = header.block_height;
    } else {
      this.block_height = null
    }
  }

  transferReceiver = async (): Promise<SwapStepResult> => {
    try {
      this.updateBlockHeight();
      let transfer_finalized_data = await this.do_transfer_receiver();
      this.statecoin.ui_swap_status = UI_SWAP_STATUS.Phase7;

      if (transfer_finalized_data !== null && transfer_finalized_data !== undefined) {
        // Update coin status
        this.statecoin.swap_transfer_finalized_data = transfer_finalized_data;
        this.statecoin.swap_status = SWAP_STATUS.Phase4;
        this.wallet.saveStateCoinsList()
        return SwapStepResult.Ok(`Received transfer finalized data.`)
      } else {
        return SwapStepResult.Retry(`Received null or undefined transfer finalized data. Retrying.`)
      }
    } catch (err: any) {
      if (err?.message && (err.message.includes("wasm_client") ||
        err.message.includes(POST_ROUTE.KEYGEN_SECOND))) {
        throw err
      }
      return SwapStepResult.Retry(err.message)
    }
  }

  // Poll swap until phase changes to Phase End. In that case complete swap by performing transfer finalize.
  swapPhase4PollSwap = async () => {
    try {
      let phase = await pollSwap(this.clients.http_client, this.getSwapID());
      return this.swapPhase4CheckPhase(phase)
    } catch (err: any) {
      if (!err.message.includes("No data for identifier")) {
        return SwapStepResult.Retry(err.message)
      } else {
        throw err
      }
    }
  }

  swapPhase4CheckPhase = (phase: string): SwapStepResult => {
    if (phase === SWAP_STATUS.Phase3) {
      return SwapStepResult.Retry("Client in swap phase 4. Server in phase 3. Awaiting phase 4. Retrying...")
    } else if (phase !== SWAP_STATUS.Phase4 && phase !== null) {
      throw new Error("Swap error: swapPhase4: Expected swap phase4 or null. Received: " + phase);
    }
    return SwapStepResult.Ok(`Swap Phase: ${phase} - Coin ${this.statecoin.shared_key_id} in Swap ${this.statecoin.swap_id}`);
  }

  getTransferFinalizedData(): TransferFinalizeData {
    const data = this.statecoin.swap_transfer_finalized_data
    if (data === null || data === undefined) {
      throw new Error("expected TransferFinalizeData, got null or undefined")
    }
    return data
  }

  setStatecoinOut = (statecoin_out: StateCoin) => {
    // Update coin status and num swap rounds
    this.statecoin.ui_swap_status = UI_SWAP_STATUS.End;
    this.statecoin.swap_status = SWAP_STATUS.End;
    statecoin_out.swap_rounds = this.statecoin.swap_rounds + 1;
    statecoin_out.anon_set = this.statecoin.anon_set + this.getSwapInfo().swap_token.statechain_ids.length;
    this.wallet.setIfNewCoin(statecoin_out)
    this.wallet.statecoins.setCoinSpent(this.statecoin.shared_key_id, ACTION.SWAP)
    // update in wallet
    statecoin_out.swap_status = null;
    statecoin_out.ui_swap_status = null;
    statecoin_out.swap_auto = this.statecoin.swap_auto
    statecoin_out.setConfirmed();
    statecoin_out.sc_address = encodeSCEAddress(statecoin_out.proof_key, this.wallet)
    this.statecoin_out = statecoin_out
    if (this.wallet.statecoins.addCoin(statecoin_out)) {
      this.wallet.saveStateCoinsList();
      log.info("Swap complete for Coin: " + this.statecoin.shared_key_id + ". New statechain_id: " + statecoin_out.shared_key_id);
    } else {
      log.info("Error on swap complete for coin: " + this.statecoin.shared_key_id + " statechain_id: " + statecoin_out.shared_key_id + "Coin duplicate");
    }
  }

  swapPhase4HandleErrPollSwap = async (): Promise<SwapStepResult> => {
    try {
      let phase = await pollSwap(this.clients.http_client, this.getSwapID());
      return SwapStepResult.Ok(phase)
    } catch (err: any) {
      if (!err.message.includes("No data for identifier")) {
        return SwapStepResult.Retry(err.message)
      }
      throw err
    }
  }

  handleTimeoutError = (err: any) => {
    if (err.message.includes('Transfer batch ended. Timeout')) {
      let error = new Error(`swap id: ${this.getSwapID().id}, shared key id: ${this.statecoin.shared_key_id} - swap failed at phase 4/4 
    due to Error: ${err.message}`);
      throw error
    }
  }

  checkBatchStatus = async (phase: string, err_msg: "string"): Promise<SwapStepResult> => {
    let batch_status = null
    try {
      if (phase === null) {
        batch_status = await getTransferBatchStatus(this.clients.http_client, this.getSwapID().id);
      }
    } catch (err: any) {
      this.handleTimeoutError(err)
      return SwapStepResult.Retry(err.message)
    }
    if (batch_status?.finalized === true) {
      return SwapStepResult.Retry(`${err_msg}: statecoin ${this.statecoin.shared_key_id} - batch transfer complete for swap ID ${this.getSwapID().id}`)
    } else {
      return SwapStepResult.Retry(`statecoin ${this.statecoin.shared_key_id} waiting for completion of batch transfer in swap ID ${this.getSwapID().id}`)
    }
  }

  transferReceiverFinalize = async (): Promise<SwapStepResult> => {
    // Complete transfer for swap and receive new statecoin  
    try {
      this.statecoin.ui_swap_status = UI_SWAP_STATUS.Phase8;
      let wasm = await this.wallet.getWasm();
      let statecoin_out = await transferReceiverFinalize(this.clients.http_client, wasm, this.getTransferFinalizedData());
      log.info(`setting statecoin out...`)
      this.setStatecoinOut(statecoin_out)
      log.info(`transfer complete.`)
      return SwapStepResult.Ok("transfer complete")
    } catch (err: any) {
      log.info(`transferReceiverFinalize error: ${err}`)
      let result = await this.swapPhase4HandleErrPollSwap()
      if (!result.is_ok()) {
        return result
      } else {
        if (err?.message && (err.message.includes("wasm_client") ||
          err.message.includes(POST_ROUTE.KEYGEN_SECOND))) {
          return SwapStepResult.Retry(err.message)
        }
        let phase = result.message
        log.debug(`checking batch status - phase: ${phase}`)
        return await this.checkBatchStatus(phase, err.message)
      }
    }
  }


  // Check statecoin is eligible for entering a swap group
  validateSwap = () => {
    validateSwap(this.statecoin)
  }

  validateResumeSwap = () => {
    const statecoin = this.statecoin
    if (statecoin.status !== STATECOIN_STATUS.IN_SWAP) throw Error("Cannot resume coin " + statecoin.shared_key_id + " - not in swap.");
    if (statecoin.swap_status !== SWAP_STATUS.Phase4)
      throw Error("Cannot resume coin " + statecoin.shared_key_id + " - swap status: " + statecoin.swap_status);
  }

  prepare_statecoin = (resume: boolean) => {
    let statecoin = this.statecoin
    // Reset coin's swap data
    if (!resume) {
      if (statecoin.swap_status === SWAP_STATUS.Phase4) {
        throw new Error(`Coin ${statecoin.shared_key_id} is in swap phase 4. Swap must be resumed.`)
      }
      if (statecoin) {
        statecoin.setSwapDataToNull()
        statecoin.swap_status = SWAP_STATUS.Init;
        statecoin.ui_swap_status = SWAP_STATUS.Init;
        statecoin.setAwaitingSwap();
      }

    }
    this.resetCounters()
  }

  do_swap_poll = async (resume: boolean = false): Promise<StateCoin | null> => {
    if (resume) {
      this.validateResumeSwap()
    } else {
      this.validateSwap()
    }
    this.prepare_statecoin(resume)
    let statecoin = this.statecoin

    await this.do_swap_steps();

    if (statecoin.swap_auto && this.statecoin_out) this.statecoin_out.swap_auto = true;
    return this.statecoin_out;
  }

  do_swap_steps = async () => {
    while (this.next_step < this.swap_steps.length) {
      await this.doNext()
      await delay(SWAP_RETRY.MEDIUM_DELAY_S)
    }
  }

}

