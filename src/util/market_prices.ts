import { BigNumber } from '0x.js';

import { CACHE_CHECK_INTERVAL, MARKET_PRICE_API_ENDPOINT } from '../common/constants';

let ethPriceInUSD: BigNumber | null;
let isActiveCache: boolean = false;

export const getEthereumPriceInUSD = async (): Promise<BigNumber> => {
    if (!ethPriceInUSD) {
        const response = await fetch(MARKET_PRICE_API_ENDPOINT);
        const ethereumPriceInUSD = await response.json();
        const priceUsd: string = (ethereumPriceInUSD as any)[0].price_usd;
        ethPriceInUSD = new BigNumber(priceUsd);
        cacheETHPrice();
    }
    return ethPriceInUSD;
};

const cacheETHPrice = () => {
    if (!isActiveCache) {
        setInterval(async () => {
            ethPriceInUSD = null;
            await getEthereumPriceInUSD();
            isActiveCache = true;
        }, CACHE_CHECK_INTERVAL);
    }
};
