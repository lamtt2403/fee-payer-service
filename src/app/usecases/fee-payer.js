const { ethers, BigNumber } = require('ethers')
const { abi } = require('../../abis/fee-payer.json');

const { ERC20ABI } = require('../../abis/erc20.json');

const { incrTxNum, getValue } = require('../connections/redis');
const { sendAlert } = require('../connections/telegram');

const { createEVMPP } = require('../../lib/evmpp')

const RPC = process.env.RPC || "http://localhost:9650/ext/bc/C/rpc"
const provider = new ethers.providers.JsonRpcProvider(RPC)

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const contract = new ethers.Contract(process.env.ADDRESS, abi, wallet)

const minFeeAlert = process.env.MINIMUM_FEE_ALERT
const fetchBalanceTxTimes = process.env.FETCH_BALANCE_TX_TIMES
const callLogsAccessList = [{
    address: "0x5555555555555555555555555555555555555555",
    storageKeys: ["0x5555555555555555555555555555555555555555555555555555555555555555"],
}]

const SGOLD_CONTRACT = process.env.SGOLD_CONTRACT;

const sgold = new ethers.Contract(SGOLD_CONTRACT, ERC20ABI, provider);


const evmpp = createEVMPP(provider, {
    returns: {
        sponsor: ''
    },
})


const txSchema = {
    nonce: value => parseInt(value) === Number(value),
    gasPrice: value => (value === null) ? true : ethers.utils.isHexString(value._hex),
    gasLimit: value => ethers.utils.isHexString(value._hex),
    to: value => ethers.utils.isAddress(value),
    value: value => ethers.utils.isHexString(value._hex),
    data: value => ethers.utils.isHexString(value),
    chainId: value => parseInt(value) === Number(value),
    v: value => parseInt(value) === Number(value),
    r: value => ethers.utils.isHexString(value),
    s: value => ethers.utils.isHexString(value),
    from: value => ethers.utils.isAddress(value),
    hash: value => ethers.utils.isHexString(value),
}

const validate = (object, schema) => Object
    .keys(schema)
    .filter(key => !schema[key](object[key]))
    .map(key => Error(`${key} is invalid.`))

const getTx = async (txHash) => {
    const txReceipt = await provider.waitForTransaction(txHash)
    return txReceipt
}

const validateTx = async (txHash) => {
    const receipt = await provider.waitForTransaction(txHash)
    if ((receipt.status === 1) && (receipt.logs.length > 0)) {
        return true
    }
    return false
}

const getBalance = async (address) => {
    const balance = await provider.getBalance(address)
    return ethers.utils.formatEther(balance)
}

const handleAlert = async (address) => {
    const txNum = await getValue(address)
    if (txNum % fetchBalanceTxTimes == 0 ) {
        const balance = await getBalance(address)
        if (balance <= minFeeAlert) {
            await sendAlert(address, balance)
        }
    }
    await incrTxNum(address)
}

function anyGtOne(logs) {
    for (const log of logs) {
        if (log.address.toLowerCase() != SGOLD_CONTRACT.toLowerCase()) {
            continue
        }

        const logDesc = sgold.interface.parseLog({ topics: log.topics, data: log.data });
        if (logDesc.name == 'Transfer' && logDesc.args[2].gt(0)) {
            return true
        }
    }
    return false
}

const wrapTx = async (rawSignedTx) => {
    let isValidSchema = false
    const tx = ethers.utils.parseTransaction(`${rawSignedTx}`)
    const errors = validate(tx, txSchema)
    if (errors.length > 0) {
        for (const { message } of errors) {
            console.log(message);
        }
        return [isValidSchema, false]
    }

    isValidSchema = true

    try {
        await evmpp.callStatic.sponsor(rawSignedTx, { accessList: callLogsAccessList })
    } catch (err) {
        if (err.reason) {
            const result = JSON.parse(err.reason)
            if (result.err || !result.logs || !anyGtOne(result.logs)) {
                return [isValidSchema, false]
            }
        } else {
            console.error(err)
            return [isValidSchema, false]
        }
    }

    const nonce = await wallet.getTransactionCount('pending')

    const res = await evmpp.connect(wallet).sponsor(rawSignedTx)

    await res.wait(1);

    const newNonce = await wallet.getTransactionCount('pending')

    await handleAlert(tx["from"])

    return [isValidSchema, (nonce + 1) === newNonce]
}


module.exports = {
    getTx: getTx,
    wrapTx: wrapTx,
    validateTx: validateTx,
    getBalance: getBalance
}