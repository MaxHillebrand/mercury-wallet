let bitcoin = require('bitcoinjs-lib')
import { Wallet, StateCoinList, ACTION, Config, STATECOIN_STATUS, BACKUP_STATUS } from '../';
import { segwitAddr } from '../wallet';
import { BIP32Interface, BIP32,  fromBase58} from 'bip32';
import { ECPair, Network, Transaction } from 'bitcoinjs-lib';
import { txWithdrawBuild, txBackupBuild } from '../util';
import { addRestoredCoinDataToWallet } from '../recovery';
import { RECOVERY_DATA, RECOVERY_DATA_C_KEY_CONVERTED } from './test_data';
import { MockElectrumClient } from "../mocks/mock_electrum";

let cloneDeep = require('lodash.clonedeep');

const SHARED_KEY_DUMMY = {public:{q: "",p2: "",p1: "",paillier_pub: {},c_key: "",},private: "",chain_code: ""};

// electrum mock
let electrum_mock = new MockElectrumClient;

describe('Wallet', function() {
  let wallet = Wallet.buildMock(bitcoin.networks.bitcoin);

  test('toJSON', function() {
    wallet.config.update({min_anon_set: 1000}); // update config to ensure defaults are not revered to after fromJSON.
    let json_wallet = JSON.parse(JSON.stringify(wallet));
    let from_json = Wallet.fromJSON(json_wallet, bitcoin.networks.bitcoin, segwitAddr, true);
    // check wallets serialize to same values (since deep equal on recursive objects is messy)
    expect(JSON.stringify(from_json)).toEqual(JSON.stringify(wallet));
  });

  test('save/load', async function() {
    wallet.save()
    let loaded_wallet = await Wallet.load('mock', '', true)
    expect(JSON.stringify(wallet)).toEqual(JSON.stringify(loaded_wallet))
  });

  test('save coins list', async function() {
    wallet.save();
    let num_coins_before = wallet.statecoins.coins.length;

    // new coin
    wallet.addStatecoinFromValues("103d2223-7d84-44f1-ba3e-4cd7dd418560", SHARED_KEY_DUMMY, 0.1, "58f2978e5c2cf407970d7213f2b428990193b2fe3ef6aca531316cdcf347cc41", 0, "03ffac3c7d7db6308816e8589af9d6e9e724eb0ca81a44456fef02c79cba984477", ACTION.DEPOSIT)
    wallet.saveStateCoinsList();

    let loaded_wallet = await Wallet.load('mock', '', true);
    let num_coins_after = loaded_wallet.statecoins.coins.length;
    expect(num_coins_after).toEqual(num_coins_before+1)
    expect(JSON.stringify(wallet)).toEqual(JSON.stringify(loaded_wallet))
  });

  test('genBtcAddress', function() {
    let addr1 = wallet.genBtcAddress();
    let addr2 = wallet.genBtcAddress();
    expect(addr1).not.toEqual(addr2)
    expect(wallet.account.containsAddress(addr1))
    expect(wallet.account.containsAddress(addr2))
  });

  test('genProofKey', function() {
    let proof_key_bip32 = wallet.genProofKey();
    let bip32 = wallet.getBIP32forProofKeyPubKey(proof_key_bip32.publicKey.toString("hex"))
    // Ensure BIP32 is correclty returned
    expect(proof_key_bip32.privateKey).toEqual(bip32.privateKey)
  });

  test('getActivityLog', function() {
    let activity_log = wallet.getActivityLog(0);
    expect(activity_log.length).toBe(0)
    activity_log = wallet.getActivityLog(2);
    expect(activity_log.length).toBe(2)
    activity_log = wallet.getActivityLog(10);
    expect(activity_log.length).toBeLessThan(10)
    for (let i = 0; i < activity_log.length; i++) {
      expect(activity_log[i]).toEqual(expect.objectContaining(
        {
          date: expect.any(Number),
          action: expect.any(String),
          value: expect.any(Number),
          funding_txid: expect.any(String)
        }))
    }
  });

  test('addStatecoin', function() {
    let [coins_before_add, total_before] = wallet.getUnspentStatecoins()
    let activity_log_before_add = wallet.getActivityLog(100)
    wallet.addStatecoinFromValues("861d2223-7d84-44f1-ba3e-4cd7dd418560", {public:{q: "",p2: "",p1: "",paillier_pub: {},c_key: "",},private: "",chain_code: ""}, 0.1, "58f2978e5c2cf407970d7213f2b428990193b2fe3ef6aca531316cdcf347cc41", 0, "03ffac3c7d7db6308816e8589af9d6e9e724eb0ca81a44456fef02c79cba984477", ACTION.DEPOSIT)
    let [coins_after_add, total_after] = wallet.getUnspentStatecoins()
    let activity_log_after_add = wallet.getActivityLog(100)
    expect(coins_before_add.length).toEqual(coins_after_add.length - 1)
    expect(activity_log_before_add.length).toEqual(activity_log_after_add.length - 1)
  });

  describe("getCoinBackupTxData", () => {
    it('shared_key_id doesnt exist', () => {
      expect(() => {
        wallet.getCoinBackupTxData("StateCoin does not exist.");
      }).toThrowError("does not exist");
    });
  })

  describe('createBackupTxCPFP', function() {
    let cpfp_data = {selected_coin: wallet.statecoins.coins[0].shared_key_id, cpfp_addr: wallet.genBtcAddress(), fee_rate: 3};
    let cpfp_data_bad_address = {selected_coin: wallet.statecoins.coins[0].shared_key_id, cpfp_addr: "tc1aaldkjqoeihj87yuih", fee_rate: 3};
    let cpfp_data_bad_coin = {selected_coin: "c93ad45a-00b9-449c-a804-aab5530efc90", cpfp_addr: wallet.genBtcAddress(), fee_rate: 3};
    let cpfp_data_bad_fee = {selected_coin: wallet.statecoins.coins[0].shared_key_id, cpfp_addr: wallet.genBtcAddress(), fee_rate: "three"};

    let tx_backup = txWithdrawBuild(bitcoin.networks.bitcoin, "86396620a21680f464142f9743caa14111dadfb512f0eb6b7c89be507b049f42", 0, wallet.genBtcAddress(), 10000, wallet.genBtcAddress(), 10, 1)

    wallet.statecoins.coins[0].tx_backup = tx_backup.buildIncomplete();

    test('Throw on invalid value', async function() {
      expect(() => {
        wallet.createBackupTxCPFP(cpfp_data_bad_address);
      }).toThrowError('Invalid Bitcoin address entered.');
      expect(() => {
        wallet.createBackupTxCPFP(cpfp_data_bad_coin);
      }).toThrowError('No coin found with id c93ad45a-00b9-449c-a804-aab5530efc90');
      expect(() => {
        wallet.createBackupTxCPFP(cpfp_data_bad_fee);
      }).toThrowError('Fee rate not an integer');
    });

    expect(wallet.createBackupTxCPFP(cpfp_data)).toBe(true);
    expect(wallet.statecoins.coins[0].tx_cpfp.outs.length).toBe(1);
  });
})

describe('updateBackupTxStatus', function() {

  let wallet = Wallet.buildMock(bitcoin.networks.bitcoin);

    test('Swaplimit', async function() {
      // locktime = 1000, height = 100 SWAPLIMIT triggered
      let tx_backup = txBackupBuild(bitcoin.networks.bitcoin, "86396620a21680f464142f9743caa14111dadfb512f0eb6b7c89be507b049f42", 0, wallet.genBtcAddress(), 10000, wallet.genBtcAddress(), 10, 1000);
      wallet.statecoins.coins[0].tx_backup = tx_backup.buildIncomplete();
      wallet.block_height = 100;
      wallet.updateBackupTxStatus();
      expect(wallet.statecoins.coins[0].status).toBe(STATECOIN_STATUS.SWAPLIMIT);
    })

    test('Expired', async function() {
      // locktime = 1000, height = 1000, EXPIRED triggered
      let tx_backup = txBackupBuild(bitcoin.networks.bitcoin, "86396620a21680f464142f9743caa14111dadfb512f0eb6b7c89be507b049f42", 0, wallet.genBtcAddress(), 10000, wallet.genBtcAddress(), 10, 1000);
      wallet.statecoins.coins[1].tx_backup = tx_backup.buildIncomplete();
      wallet.block_height = 1000;
      wallet.updateBackupTxStatus();
      expect(wallet.statecoins.coins[1].status).toBe(STATECOIN_STATUS.EXPIRED);
      // verify tx in mempool
      expect(wallet.statecoins.coins[1].backup_status).toBe(BACKUP_STATUS.IN_MEMPOOL);      
    })

    test('Confirmed', async function() {
      // blockheight 1001, backup tx confirmed, coin WITHDRAWN
      let tx_backup = txBackupBuild(bitcoin.networks.bitcoin, "58f2978e5c2cf407970d7213f2b428990193b2fe3ef6aca531316cdcf347cc41", 0, wallet.genBtcAddress(), 10000, wallet.genBtcAddress(), 10, 1000);
      wallet.statecoins.coins[1].tx_backup = tx_backup.buildIncomplete();
      wallet.block_height = 1001;
      wallet.updateBackupTxStatus();
      expect(wallet.statecoins.coins[1].status).toBe(STATECOIN_STATUS.WITHDRAWN);
      // verify tx confirmed
      expect(wallet.statecoins.coins[1].backup_status).toBe(BACKUP_STATUS.CONFIRMED); 
    })    

    test('Double spend', async function() {
      // blockheight 1001, backup tx double-spend, coin EXPIRED
      let tx_backup = txBackupBuild(bitcoin.networks.bitcoin, "01f2978e5c2cf407970d7213f2b428990193b2fe3ef6aca531316cdcf347cc41", 0, wallet.genBtcAddress(), 10000, wallet.genBtcAddress(), 10, 1000);
      wallet.statecoins.coins[0].tx_backup = tx_backup.buildIncomplete();
      wallet.block_height = 1001;
      wallet.updateBackupTxStatus();
      expect(wallet.statecoins.coins[0].status).toBe(STATECOIN_STATUS.EXPIRED);
      // verify tx confirmed
      expect(wallet.statecoins.coins[0].backup_status).toBe(BACKUP_STATUS.TAKEN); 
    })    

})

describe("Statecoins/Coin", () => {
  var statecoins = Wallet.buildMock().statecoins;

  test('to/from JSON', () => {
    var json = JSON.parse(JSON.stringify(statecoins))
    let from_json = StateCoinList.fromJSON(json)
    expect(statecoins).toEqual(from_json)
  });

  test('get/remove coin', () => {
    var json = JSON.parse(JSON.stringify(statecoins))
    statecoins = StateCoinList.fromJSON(json)
    let new_shared_key_id = "861d2223-7d84-44f1-ba3e-4cd7dd418560";

    // Check new_shared_key_id not already in coins list
    expect(statecoins.coins.filter(item =>
      {if (item.shared_key_id==new_shared_key_id){return item}}).length
    ).toEqual(0)

    // Add new coin to list
    statecoins.addNewCoin(new_shared_key_id, SHARED_KEY_DUMMY);
    expect(statecoins.coins.filter(item =>
      {if (item.shared_key_id==new_shared_key_id){return item}}).length
    ).toEqual(1)

    // Remove coin from list
    statecoins.removeCoin(new_shared_key_id, false);
    expect(statecoins.coins.filter(item =>
      {if (item.shared_key_id==new_shared_key_id){return item}}).length
    ).toEqual(0)
  });

  test('try remove confirmed coin', () => {
    var json = JSON.parse(JSON.stringify(statecoins))
    statecoins = StateCoinList.fromJSON(json)
    let new_shared_key_id = "861d2223-7d84-44f1-ba3e-4cd7dd418560";
    statecoins.addNewCoin(new_shared_key_id, SHARED_KEY_DUMMY);
    let coin = statecoins.getCoin(new_shared_key_id);
    coin.setInMempool();

    // Attempt to remove coin from list
    expect(() => {
      statecoins.removeCoin(new_shared_key_id, false)
    }).toThrowError("Should not remove coin whose funding transaction has been broadcast.")
  });

  describe("getAllCoins", () => {
    it('Returns coins with correct data', () => {
      let coins = statecoins.getAllCoins();
      expect(coins.length).toBe(statecoins.coins.length)
      for (let i = 0; i < coins.length; i++) {
        expect(coins[i]).toEqual(expect.objectContaining(
          {
            shared_key_id: expect.any(String),
            value: expect.any(Number),
            funding_txid: expect.any(String),
            funding_vout: expect.any(Number),
            timestamp: expect.any(Number),
            swap_rounds: expect.any(Number),
          }))
      }
    });
  })

  describe("getUnspentCoins", () => {
    it('Returns only unspent coins with correct data', () => {
      let coins = statecoins.getAllCoins();
      let num_coins = coins.length;
      statecoins.setCoinSpent(coins[0].shared_key_id, "W") // set one spent
      expect(statecoins.getUnspentCoins().length).toBe(num_coins-1)
      expect(coins.length).toBe(statecoins.coins.length)
    });
  });

  describe("getUnconfirmedCoinsData", () => {
    it('Returns only unconfirmed coins with correct data', () => {
      let coins = statecoins.getAllCoins();
      let num_coins = coins.length;
      let coin = statecoins.getCoin(coins[0].shared_key_id);
      coin.status="UNCONFIRMED";                 // set one unconfirmed
      statecoins.setCoinFinalized(coin);
      expect(statecoins.getUnconfirmedCoins().length).toBe(num_coins-1);
      expect(coins.length).toBe(statecoins.coins.length);
    });
  });

  describe("calcExpiryDate", () => {
    it('Calculate expiry', () => {
      let coin = cloneDeep(statecoins.coins[0]);
      let tx_backup = new Transaction();
      let locktime = 24*6*30; // month locktime
      tx_backup.locktime = locktime;
      coin.tx_backup = tx_backup;
      expect(coin.getExpiryData(locktime-1)).toEqual({blocks: 1, days: 0, months: 0, confirmations:4321});            // < 1 day to go
      expect(coin.getExpiryData(locktime+1)).toEqual({blocks: 0, days: 0, months: 0, confirmations:0});          // locktime passed
      expect(coin.getExpiryData(locktime-(24*6)+1)).toEqual({blocks: (24*6)-1, days: 0, months: 0, confirmations:4179});  // 1 block from 1 day
      expect(coin.getExpiryData(locktime-(24*6))).toEqual({blocks: 24*6, days: 1, months: 0, confirmations:4178});    // 1 day
      expect(coin.getExpiryData(locktime-(2*24*6))).toEqual({blocks: 2*24*6, days: 2, months: 0, confirmations:4034});  // 2 days
      expect(coin.getExpiryData(locktime-(29*24*6))).toEqual({blocks: 29*24*6, days: 29, months: 0, confirmations:146});  // 29 days = 0 months
      expect(coin.getExpiryData(locktime-(30*24*6))).toEqual({blocks: 30*24*6, days: 30, months: 1, confirmations:2});  // 1 month
    });
    it('no backup tx', () => {
      let coin = statecoins.coins[0];
      coin.tx_backup = null
      let expiry_data = coin.getExpiryData(999);
      expect(expiry_data.blocks).toBe(-1);
    });
  });
});


describe("Config", () => {
  var config = new Config(bitcoin.networks.bitcoin, true);
  let update = {min_anon_set: 20}

  test('update', () => {
    expect(config.min_anon_set).not.toBe(20)
    config.update(update)
    expect(config.min_anon_set).toBe(20)
  });

  test('fail update invalid value', () => {
    expect(() => {  // not enough value
      config.update({invalid: ""});
    }).toThrowError("does not exist");
  })
})



describe("Recovery", () => {
  let wallet = Wallet.buildMock(bitcoin.networks.bitcoin);
  wallet.statecoins.coins = [];
  wallet.genProofKey();
  wallet.genProofKey();
  // client side's mock
  let wasm_mock = jest.genMockFromModule('../mocks/mock_wasm');
  // server side's mock
  let http_mock = jest.genMockFromModule('../mocks/mock_http_client');

  test('run recovery', async () => {
    http_mock.post = jest.fn().mockReset()
      .mockReturnValueOnce(RECOVERY_DATA)
      .mockReturnValue([]);
    wasm_mock.convert_bigint_to_client_curv_version = jest.fn(() => RECOVERY_DATA_C_KEY_CONVERTED);

    expect(wallet.statecoins.coins.length).toBe(0);

    await addRestoredCoinDataToWallet(wallet, wasm_mock, RECOVERY_DATA);

    expect(wallet.statecoins.coins.length).toBe(1);
    expect(wallet.statecoins.coins[0].status).toBe(STATECOIN_STATUS.AVAILABLE);
    expect(wallet.statecoins.coins[0].amount).toBe(RECOVERY_DATA.amount);
  });
})
