import { BigNumber, MetamaskSubprovider, signatureUtils } from '0x.js';
import { createAction } from 'typesafe-actions';

import { TX_DEFAULTS } from '../common/constants';
import { getContractWrappers } from '../services/contract_wrappers';
import { cancelSignedOrder, getAllOrdersAsUIOrders, getUserOrdersAsUIOrders } from '../services/orders';
import { getRelayer } from '../services/relayer';
import { getTokenBalance, tokenToTokenBalance } from '../services/tokens';
import { getWeb3Wrapper, getWeb3WrapperOrThrow } from '../services/web3_wrapper';
import { getKnownTokens } from '../util/known_tokens';
import { buildLimitOrder, buildMarketOrders } from '../util/orders';
import {
    BlockchainState,
    Notification,
    OrderSide,
    RelayerState,
    Token,
    TokenBalance,
    UIOrder,
    Web3State,
} from '../util/types';

import {
    getEthAccount,
    getOpenBuyOrders,
    getOpenSellOrders,
    getSelectedToken,
    getTokenBalances,
    getWethBalance,
} from './selectors';

export const initializeBlockchainData = createAction('INITIALIZE_BLOCKCHAIN_DATA', resolve => {
    return (blockchainData: BlockchainState) => resolve(blockchainData);
});

export const initializeRelayerData = createAction('INITIALIZE_RELAYER_DATA', resolve => {
    return (relayerData: RelayerState) => resolve(relayerData);
});

export const setEthAccount = createAction('SET_ETH_ACCOUNT', resolve => {
    return (ethAccount: string) => resolve(ethAccount);
});

export const setWeb3State = createAction('SET_WEB3_STATE', resolve => {
    return (web3State: Web3State) => resolve(web3State);
});

export const setTokenBalances = createAction('SET_TOKEN_BALANCES', resolve => {
    return (tokenBalances: TokenBalance[]) => resolve(tokenBalances);
});

export const setEthBalance = createAction('SET_ETH_BALANCE', resolve => {
    return (ethBalance: BigNumber) => resolve(ethBalance);
});

export const setWethBalance = createAction('SET_WETH_BALANCE', resolve => {
    return (wethBalance: BigNumber) => resolve(wethBalance);
});

export const setOrders = createAction('SET_ORDERS', resolve => {
    return (orders: UIOrder[]) => resolve(orders);
});

export const setUserOrders = createAction('SET_USER_ORDERS', resolve => {
    return (orders: UIOrder[]) => resolve(orders);
});

export const setSelectedToken = createAction('SET_SELECTED_TOKEN', resolve => {
    return (selectedToken: Token | null) => resolve(selectedToken);
});

export const setHasUnreadNotifications = createAction('SET_HAS_UNREAD_NOTIFICATIONS', resolve => {
    return (hasUnreadNotifications: boolean) => resolve(hasUnreadNotifications);
});

export const addNotification = createAction('ADD_NOTIFICATION', resolve => {
    return (newNotification: Notification) => resolve(newNotification);
});

export const unlockToken = (token: Token) => {
    return async (dispatch: any, getState: any) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        const tokenBalances = getTokenBalances(state);

        const contractWrappers = await getContractWrappers();
        await contractWrappers.erc20Token.setUnlimitedProxyAllowanceAsync(token.address, ethAccount);

        const updatedTokenBalances = tokenBalances.map(tokenBalance => {
            if (tokenBalance.token.address !== token.address) {
                return tokenBalance;
            }

            return {
                ...tokenBalance,
                isUnlocked: true,
            };
        });

        dispatch(setTokenBalances(updatedTokenBalances));
    };
};

export const lockToken = (token: Token) => {
    return async (dispatch: any, getState: any) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        const tokenBalances = getTokenBalances(state);

        const contractWrappers = await getContractWrappers();

        await contractWrappers.erc20Token.setProxyAllowanceAsync(
            token.address,
            ethAccount,
            new BigNumber('0'),
            TX_DEFAULTS,
        );

        const updatedTokenBalances = tokenBalances.map(tokenBalance => {
            if (tokenBalance.token.address !== token.address) {
                return tokenBalance;
            }
            return {
                ...tokenBalance,
                isUnlocked: false,
            };
        });

        dispatch(setTokenBalances(updatedTokenBalances));
    };
};

export const updateWethBalance = (newWethBalance: BigNumber) => {
    return async (dispatch: any, getState: any) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        const wethBalance = getWethBalance(state);

        const web3Wrapper = await getWeb3WrapperOrThrow();
        const networkId = await web3Wrapper.getNetworkIdAsync();
        const wethAddress = getKnownTokens(networkId).getWethToken().address;

        const contractWrappers = await getContractWrappers();

        let tx: string;
        if (wethBalance.lessThan(newWethBalance)) {
            tx = await contractWrappers.etherToken.depositAsync(
                wethAddress,
                newWethBalance.sub(wethBalance),
                ethAccount,
            );
        } else if (wethBalance.greaterThan(newWethBalance)) {
            tx = await contractWrappers.etherToken.withdrawAsync(
                wethAddress,
                wethBalance.sub(newWethBalance),
                ethAccount,
                TX_DEFAULTS,
            );
        } else {
            return;
        }

        await web3Wrapper.awaitTransactionSuccessAsync(tx);
        const ethBalance = await web3Wrapper.getBalanceInWeiAsync(ethAccount);

        dispatch(setEthBalance(ethBalance));
        dispatch(setWethBalance(newWethBalance));
    };
};

export const initWallet = () => {
    return async (dispatch: any) => {
        dispatch(setWeb3State(Web3State.Loading));

        const web3Wrapper = await getWeb3Wrapper();

        if (web3Wrapper) {
            const [ethAccount] = await web3Wrapper.getAvailableAddressesAsync();
            const networkId = await web3Wrapper.getNetworkIdAsync();

            const knownTokens = getKnownTokens(networkId);

            const tokenBalances = await Promise.all(
                knownTokens.getTokens().map(token => tokenToTokenBalance(token, ethAccount)),
            );

            const wethToken = knownTokens.getWethToken();

            const ethBalance = await web3Wrapper.getBalanceInWeiAsync(ethAccount);
            const wethBalance = await getTokenBalance(wethToken, ethAccount);

            const selectedToken = knownTokens.getTokenBySymbol('ZRX');

            dispatch(
                initializeBlockchainData({
                    web3State: Web3State.Done,
                    ethAccount,
                    ethBalance,
                    wethBalance,
                    tokenBalances,
                }),
            );
            dispatch(
                initializeRelayerData({
                    orders: [],
                    userOrders: [],
                    selectedToken,
                }),
            );
            dispatch(getAllOrders());
            dispatch(getUserOrders());
        } else {
            dispatch(setWeb3State(Web3State.Error));
        }
    };
};

export const getAllOrders = () => {
    return async (dispatch: any, getState: any) => {
        const state = getState();
        const selectedToken = getSelectedToken(state) as Token;
        const uiOrders = await getAllOrdersAsUIOrders(selectedToken);

        dispatch(setOrders(uiOrders));
    };
};

export const getUserOrders = () => {
    return async (dispatch: any, getState: any) => {
        const state = getState();
        const selectedToken = getSelectedToken(state) as Token;
        const ethAccount = getEthAccount(state);
        const myUIOrders = await getUserOrdersAsUIOrders(selectedToken, ethAccount);

        dispatch(setUserOrders(myUIOrders));
    };
};

export const cancelOrder = (order: UIOrder) => {
    return async (dispatch: any, getState: any) => {
        const state = getState();
        const selectedToken = getSelectedToken(state) as Token;

        await cancelSignedOrder(order.rawOrder);

        dispatch(getAllOrders());
        dispatch(getUserOrders());

        dispatch(
            addNotification({
                kind: 'CancelOrderNotification',
                amount: order.size,
                token: selectedToken,
                timestamp: new Date(),
            }),
        );
    };
};

export const submitLimitOrder = (amount: BigNumber, price: BigNumber, side: OrderSide) => {
    return async (dispatch: any, getState: any) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        const selectedToken = getSelectedToken(state) as Token;

        const relayer = getRelayer();
        const web3Wrapper = await getWeb3WrapperOrThrow();
        const networkId = await web3Wrapper.getNetworkIdAsync();
        const contractWrappers = await getContractWrappers();

        const wethAddress = getKnownTokens(networkId).getWethToken().address;

        const order = buildLimitOrder(
            {
                account: ethAccount,
                amount,
                price,
                tokenAddress: selectedToken.address,
                wethAddress,
                exchangeAddress: contractWrappers.exchange.address,
            },
            side,
        );

        const provider = new MetamaskSubprovider(web3Wrapper.getProvider());
        const signedOrder = await signatureUtils.ecSignOrderAsync(provider, order, ethAccount);

        await relayer.client.submitOrderAsync(signedOrder);

        dispatch(getAllOrders());
        dispatch(getUserOrders());

        dispatch(
            addNotification({
                kind: 'LimitNotification',
                amount,
                token: selectedToken,
                side,
                timestamp: new Date(),
            }),
        );
    };
};

export const submitMarketOrder = (amount: BigNumber, side: OrderSide) => {
    return async (dispatch: any, getState: any) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        const selectedToken = getSelectedToken(state) as Token;

        const contractWrappers = await getContractWrappers();
        const web3Wrapper = await getWeb3WrapperOrThrow();

        const orders = side === OrderSide.Buy ? getOpenSellOrders(state) : getOpenBuyOrders(state);

        const [ordersToFill, amounts, canBeFilled] = buildMarketOrders(
            {
                amount,
                orders,
            },
            side,
        );

        if (canBeFilled) {
            const txHash = await contractWrappers.exchange.batchFillOrdersAsync(
                ordersToFill,
                amounts,
                ethAccount,
                TX_DEFAULTS,
            );
            dispatch(getAllOrders());
            dispatch(getUserOrders());

            const tx = web3Wrapper.awaitTransactionMinedAsync(txHash);

            dispatch(
                addNotification({
                    kind: 'MarketNotification',
                    amount,
                    token: selectedToken,
                    side,
                    tx,
                    timestamp: new Date(),
                }),
            );
        } else {
            window.alert('There are no enough orders to fill this amount');
        }
    };
};
