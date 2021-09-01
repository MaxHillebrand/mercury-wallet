import React, {useEffect, useState} from 'react';
import {Link, withRouter, Redirect} from "react-router-dom";
import {useDispatch} from 'react-redux'

import {StdButton, AddressInput, CopiedButton} from "../../components";
import QRCode from 'qrcode.react';

import {isWalletLoaded, callNewSeAddr, callGetSeAddr, callGetNumSeAddr, callTransferReceiver, callGetTransfers, setError, setNotification, callPingElectrum} from '../../features/WalletDataSlice'
import {fromSatoshi} from '../../wallet'

import Loading from '../../components/Loading/Loading';

import arrow from "../../images/arrow-up.png"
import icon2 from "../../images/icon2.png";
import closeIcon from "../../images/close-icon.png";

import './Receive.css';
import '../Send/Send.css';

import { Transaction } from 'bitcoinjs-lib';

let addr_index = - 1;

const ReceiveStatecoinPage = () => {
  const dispatch = useDispatch();

  const [transfer_msg3, setTransferMsg3] = useState("");
  const [openTransferKey, setOpenTransferKey] = useState(false)
  const [electrumServer, setElectrumServer] = useState(false)
  const [transferLoading,setTransferLoading] = useState(false)
  const [transferKeyLoading,setTransferKeyLoading] = useState(false)
  const [counter,setCounter] = useState(0)

  const onTransferMsg3Change = (event) => {
    setTransferMsg3(event.target.value);
  };

  let num_addresses = callGetNumSeAddr();
  if(addr_index === -1) { addr_index = num_addresses - 1 };

  const [rec_sce_addr, setRecAddr] = useState(callGetSeAddr(addr_index));

  useEffect(()=> {
    // Check if Electrum server connected on page open

    checkElectrum();
    const interval = setInterval(()=> {
      //Check Electrum server every 5s
      checkElectrum();

      //Counter triggers interval to run every time it's called
      setCounter(counter+1)

    },10000)
    return()=> clearInterval(interval)
    
  },[counter])

  const checkElectrum = () => {
    callPingElectrum().then((res) => {
      if(res.height){
        setElectrumServer(true)
      }
    }).catch((err)=> {
      setElectrumServer(false)
    })
  }
  
  // Check if wallet is loaded. Avoids crash when Electrorn real-time updates in developer mode.
  if (!isWalletLoaded()) {
    return <Redirect to="/" />;
  }

  const genAddrButtonAction = async () => {
    callNewSeAddr()
    num_addresses = callGetNumSeAddr();
    setRecAddr(callGetSeAddr(num_addresses - 1));
    addr_index = num_addresses - 1
  }

  const prevAddrButtonAction = async () => {
    if (addr_index < 1) {
      addr_index = 0
    } else {
      addr_index--
    }
    setRecAddr(callGetSeAddr(addr_index))
  }
 
  const nextAddrButtonAction = async () => {
    if (addr_index >= (num_addresses - 1)) {
      addr_index = num_addresses - 1
    } else {
      addr_index++
    }
    setRecAddr(callGetSeAddr(addr_index))
  }

  const receiveButtonAction =() => {
    // if transfer key box empty, then query server for transfer messages
    if(electrumServer){
      setTransferLoading(true)
      dispatch(callGetTransfers(addr_index)).then((res) => {
        let [nreceived, error ] = res.payload.split("../..")
        // Set Number of received statecoins and error 

        if (nreceived===0) {
            dispatch(setError({msg: "No transfers to receive."}))
          } else {
            dispatch(setNotification({msg:`Received ${nreceived} statecoins.`}))
        }
        if(error !== ""){
          dispatch(setError({msg: "Requested Statecoin(s) Corrupted"}))
        }

        setTransferLoading(false)
      })
      return
    }
    else{
      dispatch(setError({msg: "The Electrum network connection is lost"}))
    }
  }

  
  const receiveWithKey = () => {
    // Receive with transfer key
    setTransferKeyLoading(true)
    dispatch(callTransferReceiver(transfer_msg3)).then((res) => {
      if (res.error===undefined) {
        setTransferMsg3("")
        let amount = res.payload.state_chain_data.amount
        let locktime = Transaction.fromHex(res.payload.tx_backup_psm.tx_hex).locktime
        dispatch(setNotification({msg:"Transfer of "+fromSatoshi(amount)+" BTC complete! StateCoin expires at block height "+locktime+"."}))
      }
      setTransferKeyLoading(false)
    })
  }


  const handleOpenTransferKey = () => {
    if(electrumServer){
      setOpenTransferKey(!openTransferKey)
    }
    else{
      dispatch(setError({msg: `The Electrum network connection is lost`}))
    }
  }
  
  const copySEAddressToClipboard = (e) => {
    navigator.clipboard.writeText(rec_sce_addr.sce_address);
  }

  const tooltipHover = (e) => {
    var tooltipSpan = document.querySelector('.receiveStatecoin-scan-txid span.tooltip');
    if(tooltipSpan !== null){
      var w = window.innerWidth;
      var h = window.innerHeight;
  
      var x = e.clientX;
      var y = e.clientY;
  
      tooltipSpan.style.top = `${y+16}px`;

      if(x >= w-370){
        tooltipSpan.style.left = `${w-370+72}px`;
      }
      else{
        tooltipSpan.style.left = `${x+72}px`;
      }

    }
  }

  const usedMessage = (coin_status) => {
    if(coin_status === "SWAPPED") return "In Swap"
    if(coin_status === "IN_TRANSFER") return "In Transfer"
    if(coin_status === "AWAITING_SWAP") return "Awaiting Swap"
    if(coin_status == "INITIALISED") return "Initialised Coin"
    else return `StateCoin Deposit`
  }

  
  return (
    <div className="container ">
        <div className="Body receiveStatecoin">
            <div className="swap-header">
                <h2 className="WalletAmount">
                    <img src={arrow} alt="arrow"/>
                    Receive Statecoins
                </h2>
                <div>
                    <Link className="nav-link" to="/home">
                        <StdButton
                            label="Back"
                            className="Body-button transparent"/>
                    </Link>
                </div>
            </div>
            <h3 className="subtitle">
                Use the address below to receive Statecoins
            </h3>
        </div>

        <div className="receiveStatecoin content">
          <div className="Body">
            <p className="receive-note">Statecoin Address</p>
            <div className="receiveStatecoin-scan">
              <div className="receive-qr-code">
                {rec_sce_addr.sce_address? (<QRCode value={rec_sce_addr.sce_address} />):(null)}
              </div>
              <div className="receiveStatecoin-scan-content">
                  <div className="receiveStatecoin-scan-txid" onMouseMove = {e => tooltipHover(e)}>
                    <CopiedButton 
                      handleCopy={copySEAddressToClipboard} 
                      style={{
                        bottom: '-30px',
                        top: 'initial',
                        backgroundColor: '#E0E0E0',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        color: '#000',
                        fontWeight: 'bold'
                      }} 
                      message='Copied to Clipboard'
                      className={rec_sce_addr.used === true ? (`copy-btn-wrap used`): ("copy-btn-wrap")}
                    >
                      <div className="address-index">
                        <div className="address">
                          <img type="button" src={icon2} alt="icon"/>
                          <span className="rec-address">
                            {rec_sce_addr.sce_address}
                          </span>
                        </div>
                        <button type="button" className={`Body-button receive-btn btn ${transfer_msg3 ? 'active': ''}`} onClick={(transferLoading||transferKeyLoading)===false?(receiveButtonAction):((e)=>{e.stopPropagation()})}>
                          {transferLoading?(<Loading />) : (`RECEIVE Index: ${addr_index}`)}
                        </button>
                      </div>
                    </CopiedButton>
                    {rec_sce_addr.used === true ? (
                    <span className="tooltip">
                      <div><b>Used: </b> {usedMessage(rec_sce_addr.coin_status)}</div>
                      <div><b>Amount: </b> {rec_sce_addr.amount} BTC</div>
                      {rec_sce_addr.txid_vout !== "" ? (<div><b>TxID-VOUT: </b> {rec_sce_addr.txid_vout}</div>):(null)}
                    </span>
                    ):(null)}
                  </div>
                  <div className="btns-container">
                    <div className="prev-next">
                      <button
                        type="button"
                        className="Body-button transparent"
                        onClick={prevAddrButtonAction}>
                          PREV
                      </button>
                      <button
                        type="button"
                        className="Body-button transparent"
                        onClick={nextAddrButtonAction}>
                          NEXT
                      </button>    
                    </div>
                    <button
                      type="button"
                      className="Body-button transparent"
                      onClick={genAddrButtonAction}>
                        GENERATE ANOTHER ADDRESS
                    </button>   
                    <div className ="receive-btns">
                      <button type="button" className={`Body-button receive-btn btn ${transfer_msg3 ? 'active': ''}`} onClick={(transferLoading||transferKeyLoading)===false?(handleOpenTransferKey):(null)}>
                        {transferKeyLoading? (<Loading/>):("RECEIVE WITH KEY")}
                      </button>
                    </div>           
                </div>
              </div>
            </div>
          </div>
        </div>

        { openTransferKey===true ? (
        <div className="receiveStatecoin sendStatecoin content">
          <div className="overlay" onClick={handleOpenTransferKey}></div>
          <div className="Body center">
            <button className="primary-btm ghost" onClick={handleOpenTransferKey}>
              <img src={closeIcon} alt="close-button"/>
            </button>
            <p className="receive-note">Transfer Key:</p>
            <div className="receive-bottom">
              <AddressInput
                inputAddr={transfer_msg3}
                onChange={onTransferMsg3Change}
                placeholder='mm1...'
                smallTxtMsg='Transfer Code'/>
              <button type="button" className={`btn ${transfer_msg3 ? 'active': ''}`} onClick={(transferLoading||transferKeyLoading)===false?(receiveWithKey):(null)}>
                {transferKeyLoading? (<Loading/>):("RECEIVE")}
              </button>
            </div>
          </div>
        </div>):(null)}
    </div>
  )
}

export default withRouter(ReceiveStatecoinPage);
