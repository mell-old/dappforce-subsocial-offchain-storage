import { substrateLog as log } from '../connections/loggers';
import { shouldHandleEvent, eventsFilterMethods } from './utils';
import { readOffchainState, writeOffchainState } from './offchain-state';
import { handleEventForElastic } from './handle-elastic';
import { handleEventForPostgres } from './handle-postgres';
import { SubsocialSubstrateApi } from '@subsocial/api/substrate';
import { resolveSubsocialApi, substrate } from '../connections/subsocial';
import BN from 'bn.js';

require('dotenv').config()

let lastBlockNumber: BN | undefined = undefined
let blockTime = 6

export const getValidDate = async (eventBlock: BN) => {
  const api = await substrate.api
  const currentTimestamp = await api.query.timestamp.now()
  
  const result = currentTimestamp.sub(lastBlockNumber.sub(eventBlock).muln(blockTime))

  return new Date(result.toNumber())
}

async function main (substrate: SubsocialSubstrateApi) {

  log.info(`Subscribe to Substrate events: ${Array.from(eventsFilterMethods)}`)

  const api = await substrate.api

  blockTime = api.consts.timestamp?.minimumPeriod.muln(2).toNumber()

  const waitNextBlock = async () =>
    new Promise(resolve => setTimeout(resolve, blockTime))

  const state = await readOffchainState()

  // Clean up the state from the last errors:
  delete state.postgres.lastError
  delete state.elastic.lastError

  const lastPostgresBlock = () => state.postgres.lastBlock
  const lastElasticBlock = () => state.elastic.lastBlock

  const lastPostgresError = () => state.postgres.lastError
  const lastElasticError = () => state.elastic.lastError

  // Set default vals:
  let processPostgres = true
  let processElastic = true
  let lastBlock = 0
  let blockToProcess = 0

  const getBestFinalizedBlock = async () =>
    await api.derive.chain.bestNumberFinalized()

  let bestFinalizedBlock = await getBestFinalizedBlock()

  api.rpc.chain.subscribeNewHeads(async (header) => {
    lastBlockNumber = header.number.toBn()
  })

  if (!lastBlockNumber) {
    await waitNextBlock()
  } 

  while (true) {

    if (lastPostgresError() && lastElasticError()) {
      log.warn('Both Postgres and Elastic event handlers returned errors. Cannot continue event processing')
      break
    }

    // Reset processing flags:
    processPostgres = !lastPostgresError()
    processElastic = !lastElasticError()

    // Doesn't matter if both Postgres and Elastic have the same last block number:
    lastBlock = lastPostgresBlock()

    if (processPostgres && (!processElastic || lastPostgresBlock() < lastElasticBlock())) {
      lastBlock = lastPostgresBlock()
      processElastic = false
    } else if (processElastic && (!processPostgres || lastElasticBlock() < lastPostgresBlock())) {
      lastBlock = lastElasticBlock()
      processPostgres = false
    }

    blockToProcess = lastBlock + 1

    if (bestFinalizedBlock.toNumber() < blockToProcess) {
      log.debug('Waiting for the best finalized block...')
      await waitNextBlock()
      bestFinalizedBlock = await getBestFinalizedBlock()
      continue
    }

    const blockNumber = api.createType('BlockNumber', blockToProcess)
    const blockHash = await api.rpc.chain.getBlockHash(blockNumber)

    // TODO Improve performance: query events from multiple blocks at a time:
    const events = await api.query.system.events.at(blockHash)

    log.debug(`Best finalized block: ${bestFinalizedBlock.toString()}`)
    log.debug(`Block number to process: ${blockToProcess} with hash ${blockHash.toHex()}`)

    // Process all events of the current block
    // for (const { event } of events) {
      for (let i = 0; i < events.length; i++) {
      const { event } = events[i]

      if (shouldHandleEvent(event)) {
        log.debug(`Handle a new event: `, event.method)
        // 773059
        const eventMeta = {
          eventName: event.method,
          data: event.data,
          blockNumber: blockNumber,
          eventIndex: i
        }

        if (processPostgres) {
          const error = await handleEventForPostgres(eventMeta)
          if (error) {
            processPostgres = false
            state.postgres.lastError = error.toString()
            state.postgres.lastBlock = blockToProcess - 1
          }
        }

        if (processElastic) {
          const error = await handleEventForElastic(eventMeta)
          if (error) {
            processElastic = false
            state.elastic.lastError = error.toString()
            state.elastic.lastBlock = blockToProcess - 1
          }
        }
      }
    }

    if (processPostgres) {
      state.postgres.lastBlock = blockToProcess
    }

    if (processElastic) {
      state.elastic.lastBlock = blockToProcess
    }

    await writeOffchainState(state)
  }
}

resolveSubsocialApi()
  .then(({ substrate }) => main(substrate))
  .catch((error) => {
    log.error('Unexpected error during processing of Substrate events:', error)
    process.exit(-1)
  })
  
