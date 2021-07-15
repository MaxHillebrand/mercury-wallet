
import React from 'react';
import {callRemoveCoin} from '../../../features/WalletDataSlice'
import close_img from "../../../images/close-icon.png";
import './DeleteCoin.css'

const DeleteCoin = (props) => {
    const {shared_key_id} = props;

    const onCloseArrowClick = () => {
        callRemoveCoin(shared_key_id);
    }

    return (
        <img className='close' src={close_img} alt="arrow" onClick={onCloseArrowClick}/>
    );
}

export default DeleteCoin;

