// tslint:disable:no-console
import { web3Factory } from '@0x/dev-utils';
import { Web3ProviderEngine } from '@0x/subproviders';
import R = require('ramda');
import 'reflect-metadata';
import { Connection, ConnectionOptions, createConnection, Repository } from 'typeorm';

import { ExchangeEventsSource } from '../data_sources/contract-wrappers/exchange_events';
import { ExchangeFillEvent } from '../entities';
import * as ormConfig from '../ormconfig';
import { parseExchangeEvents } from '../parsers/events';
import { handleError } from '../utils';

const EXCHANGE_START_BLOCK = 6271590; // Block number when the Exchange contract was deployed to mainnet.
const START_BLOCK_OFFSET = 1000; // Number of blocks before the last known block to consider when updating fill events.
const BATCH_SAVE_SIZE = 10000; // Number of events to save at once.

let connection: Connection;

(async () => {
    connection = await createConnection(ormConfig as ConnectionOptions);
    const provider = web3Factory.getRpcProvider({
        rpcUrl: 'https://mainnet.infura.io',
    });
    await getExchangeEventsAsync(provider);
    process.exit(0);
})().catch(handleError);

async function getExchangeEventsAsync(provider: Web3ProviderEngine): Promise<void> {
    console.log('Checking existing event logs...');
    const eventsRepository = connection.getRepository(ExchangeFillEvent);
    const manager = connection.createEntityManager();
    const startBlock = await getStartBlockAsync(eventsRepository);
    console.log(`Getting event logs starting at ${startBlock}...`);
    const exchangeEvents = new ExchangeEventsSource(provider, 1);
    const eventLogs = await exchangeEvents.getFillEventsAsync(startBlock);
    console.log('Parsing events...');
    const events = parseExchangeEvents(eventLogs);
    console.log(`Retrieved and parsed ${events.length} total events.`);
    console.log('Saving events...');
    // Note(albrow): This is a temporary hack because `save` is not working as
    // documented and is causing a foreign key constraint violation. Hopefully
    // can remove later because this "poor man's upsert" implementation operates
    // on one event at a time and is therefore much slower.
    // await eventsRepository.save(events, { chunk: Math.ceil(events.length / BATCH_SAVE_SIZE) });
    for (const event of events) {
        try {
            await eventsRepository.save(event);
        } catch {
            // Assume this is a foreign key constraint error and try doing an
            // update instead.
            await eventsRepository.update(
                {
                    contractAddress: event.contractAddress,
                    blockNumber: event.blockNumber,
                    logIndex: event.logIndex,
                },
                event,
            );
        }
    }
    const totalEvents = await eventsRepository.count();
    console.log(`Done saving events. There are now ${totalEvents} total events.`);
}

async function getStartBlockAsync(eventsRepository: Repository<ExchangeFillEvent>): Promise<number> {
    const fillEventCount = await eventsRepository.count();
    if (fillEventCount === 0) {
        console.log('No existing fill events found.');
        return EXCHANGE_START_BLOCK;
    }
    const queryResult = await connection.query(
        'SELECT block_number FROM raw.exchange_fill_events ORDER BY block_number DESC LIMIT 1',
    );
    const lastKnownBlock = queryResult[0].block_number;
    return lastKnownBlock - START_BLOCK_OFFSET;
}