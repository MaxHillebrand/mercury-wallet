
import React from 'react';
import {callRemoveCoin} from '../../../features/WalletDataSlice'
import close_img from "../../../images/close-icon.png";
import './DeleteCoin.css'

const DeleteCoin = (props) => {
    const {shared_key_id, parent_setState, deletecoinShow} = props;

    const onCloseArrowClick = () => {
        //deletecoinShow = true;
        
        /*
        callRemoveCoin(shared_key_id);
        parent_setState({}); // force a re render the parent state
        */
    }

    return (
        <img className='close' src={close_img} alt="arrow"/>
    );
}

export default DeleteCoin;

