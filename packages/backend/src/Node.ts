import * as WebSocket from 'ws';
import * as EventEmitter from 'events';

import { noop, timestamp, idGenerator, Maybe, Types, NumStats } from '@dotstats/common';
import { BlockHash, BlockNumber, ConsensusView } from "@dotstats/common/build/types";
import {
  parseMessage,
  getBestBlock,
  Message,
  BestBlock,
  SystemInterval,
  AfgFinalized,
  AfgReceivedPrecommit,
  AfgReceivedPrevote,
  AfgAuthoritySet,
  NotifyFinalized,
} from './message';
import { locate, Location } from './location';
import MeanList from './MeanList';
import Block from './Block';
import { MAX_BLOCKS_IN_CHAIN_CACHE } from './Chain';

const BLOCK_TIME_HISTORY = 10;
const MEMORY_RECORDS = 20;
const CPU_RECORDS = 20;
const TIMEOUT = (1000 * 60 * 1) as Types.Milliseconds; // 1 minute
const MAX_BLOCKS_IN_NODE_CACHE = MAX_BLOCKS_IN_CHAIN_CACHE;

const nextId = idGenerator<Types.NodeId>();

export interface NodeEvents {
  on(event: 'location', fn: (location: Location) => void): void;
  emit(event: 'location', location: Location): void;
}

export default class Node {
  public readonly id: Types.NodeId;
  public readonly name: Types.NodeName;
  public readonly chain: Types.ChainLabel;
  public readonly implementation: Types.NodeImplementation;
  public readonly version: Types.NodeVersion;
  public readonly address: Maybe<Types.Address>;
  public readonly networkId: Maybe<Types.NetworkId>;
  public readonly authority: boolean;

  public readonly events = new EventEmitter() as EventEmitter & NodeEvents;

  public networkState: Maybe<Types.NetworkState> = null;
  public location: Maybe<Location> = null;
  public lastMessage: Types.Timestamp;
  public config: string;
  public best = Block.ZERO;
  public finalized = Block.ZERO;
  public latency = 0 as Types.Milliseconds;
  public blockTime = 0 as Types.Milliseconds;
  public blockTimestamp = 0 as Types.Timestamp;
  public propagationTime: Maybe<Types.PropagationTime> = null;

  private peers = 0 as Types.PeerCount;
  private txcount = 0 as Types.TransactionCount;
  private memory = new MeanList<Types.MemoryUse>();
  private cpu = new MeanList<Types.CPUUse>();
  private upload = new MeanList<Types.BytesPerSecond>();
  private download = new MeanList<Types.BytesPerSecond>();
  private chartstamps = new MeanList<Types.Timestamp>();

  private readonly ip: string;
  private readonly socket: WebSocket;
  private blockTimes = new NumStats<Types.Milliseconds>(BLOCK_TIME_HISTORY);
  private lastBlockAt: Maybe<Date> = null;
  private pingStart = 0 as Types.Timestamp;
  private throttle = false;

  // how this node views itself and others
  public consensusCache: ConsensusView = [];

  private authorities: Types.Authorities = [] as Types.Authorities;
  private authoritySetId: Types.AuthoritySetId = 0 as Types.AuthoritySetId;

  constructor(
    ip: string,
    socket: WebSocket,
    name: Types.NodeName,
    chain: Types.ChainLabel,
    config: string,
    implentation: Types.NodeImplementation,
    version: Types.NodeVersion,
    address: Maybe<Types.Address>,
    networkId: Maybe<Types.NetworkId>,
    authority: boolean,
    messages: Array<Message>,
  ) {
    this.ip = ip;
    this.id = nextId();
    this.name = name;
    this.chain = chain;
    this.config = config;
    this.implementation = implentation;
    this.version = version;
    this.address = address;
    this.authority = authority;
    this.networkId = networkId;
    this.lastMessage = timestamp();
    this.socket = socket;

    socket.on('message', (data) => {
      const message = parseMessage(data);

      if (!message) {
        return;
      }

      this.onMessage(message);
    });

    socket.on('close', () => {
      console.log(`${this.name} has disconnected`);

      this.disconnect();
    });

    socket.on('error', (error) => {
      console.error(`${this.name} has errored`, error);

      this.disconnect();
    });

    socket.on('pong', () => {
      this.latency = (timestamp() - this.pingStart) as Types.Milliseconds;
      this.pingStart = 0 as Types.Timestamp;
    });

    process.nextTick(() => {
      // Handle cached messages
      for (const message of messages) {
        this.onMessage(message);
      }
    });

    locate(ip).then((location) => {
      if (!location) {
        return;
      }

      this.location = location;

      this.events.emit('location', location);
    });
  }

  public static fromSocket(socket: WebSocket, ip: string): Promise<Node> {
    return new Promise((resolve, reject) => {
      function cleanup() {
        clearTimeout(timeout);
        socket.removeAllListeners('message');
      }

      const messages: Array<Message> = [];

      function handler(data: WebSocket.Data) {
        const message = parseMessage(data);

        if (!message || !message.msg) {
          return;
        }

        if (message.msg === "system.connected") {
          cleanup();

          const { name, chain, config, implementation, version, pubkey, authority, network_id: networkId } = message;

          resolve(new Node(ip, socket, name, chain, config, implementation, version, pubkey, networkId, authority === true, messages));
        } else {
          if (messages.length === 10) {
            messages.shift();
          }

          messages.push(message);
        }
      }

      socket.on('message', handler);

      const timeout = setTimeout(() => {
        cleanup();

        socket.close();
        socket.terminate();

        return reject(new Error('Timeout on waiting for system.connected message'));
      }, 5000);
    });
  }

  public timeoutCheck(now: Types.Timestamp) {
    if (this.lastMessage + TIMEOUT < now) {
      this.disconnect();
    } else {
      this.updateLatency(now);
    }
  }

  public nodeDetails(): Types.NodeDetails {
    const authority = this.authority ? this.address : null;
    const addr = this.address ? this.address : '' as Types.Address;

    return [this.name, addr, this.implementation, this.version, authority, this.networkId];
  }

  public nodeStats(): Types.NodeStats {
    return [this.peers, this.txcount];
  }

  public nodeHardware(): Types.NodeHardware {
    return [this.memory.get(), this.cpu.get(), this.upload.get(), this.download.get(), this.chartstamps.get()];
  }

  public blockDetails(): Types.BlockDetails {
    return [this.best.number, this.best.hash, this.blockTime, this.blockTimestamp, this.propagationTime];
  }

  public nodeLocation(): Maybe<Types.NodeLocation> {
    const { location } = this;

    return location ? [location.lat, location.lon, location.city] : null;
  }

  public get average(): Types.Milliseconds {
    return this.blockTimes.average();
  }

  public get localBlockAt(): Types.Milliseconds {
    if (!this.lastBlockAt) {
      return 0 as Types.Milliseconds;
    }

    return +(this.lastBlockAt || 0) as Types.Milliseconds;
  }

  private disconnect() {
    this.socket.removeAllListeners();
    this.socket.close();
    this.socket.terminate();

    this.events.emit('disconnect');
  }

  private onMessage(message: Message) {
    this.lastMessage = timestamp();

    const update = getBestBlock(message);

    if (update) {
      this.updateBestBlock(update);
    }

    if (message.msg === 'system.interval') {
      this.onSystemInterval(message);
    }

    if (message.msg === 'notify.finalized') {
      this.onNotifyFinalized(message);
    }
    if (message.msg === 'afg.finalized') {
      this.onAfgFinalized(message);
    }
    if (message.msg === 'afg.received_precommit') {
      this.onAfgReceivedPrecommit(message);
    }
    if (message.msg === 'afg.received_prevote') {
      this.onAfgReceivedPrevote(message);
    }
    if (message.msg === 'afg.authority_set') {
      this.onAfgAuthoritySet(message);
    }
    this.truncateBlockCache();
  }

  private onSystemInterval(message: SystemInterval) {
    const {
      network_state,
      peers,
      txcount,
      cpu,
      memory,
      bandwidth_download: download,
      bandwidth_upload: upload,
      finalized_height: finalized,
      finalized_hash: finalizedHash
    } = message;

    if (this.networkState !== network_state && network_state) {
      this.networkState = network_state;
    };

    if (this.peers !== peers || this.txcount !== txcount) {
      this.peers = peers;
      this.txcount = txcount;

      this.events.emit('stats');
    }

    if (finalized != null && finalizedHash != null && finalized > this.finalized.number) {
      this.finalized = new Block(finalized, finalizedHash);

      this.events.emit('finalized');
    }

    if (cpu != null && memory != null) {
      const cpuChange = this.cpu.push(cpu);
      const memChange = this.memory.push(memory);

      const uploadChange = this.upload.push(upload);
      const downloadChange = this.download.push(download);

      const stampChange = this.chartstamps.push(timestamp());

      if (cpuChange || memChange || uploadChange || downloadChange || stampChange) {
        this.events.emit('hardware');
      }
    }
  }

  public initialiseConsensusView(height: Types.BlockNumber, addr: Maybe<Types.Address>) {
    if (!(height in this.consensusCache)) {
      this.consensusCache[height] = {};
    }
    if (addr && !(addr in this.consensusCache[height])) {
      this.consensusCache[height][addr] = {} as Types.ConsensusInfo;
    }
  }

  public resetCache() {
    this.consensusCache = {} as ConsensusView;
  }

  public isAuthority(): boolean {
    return this.authority;
  }

  private onNotifyFinalized(message: NotifyFinalized) {
    const {
      best: best,
      height: height,
    } = message;

    this.initialiseConsensusView(height as BlockNumber, this.address);
    this.consensusCache[height as BlockNumber][String(this.address)].FinalizedHash = best;
    this.events.emit('consensus-info');
  }

  public markFinalized(finalizedHeight: BlockNumber, finalizedHash: BlockHash) {
    let addr = String(this.address);

    this.initialiseConsensusView(finalizedHeight, this.address);
    this.consensusCache[finalizedHeight][addr].Finalized = true;
    this.consensusCache[finalizedHeight][addr].FinalizedHash = finalizedHash;
    this.consensusCache[finalizedHeight][addr].FinalizedHeight = finalizedHeight;

    // this is extrapolated. if this app was just started up we
    // might not yet have received prevotes/precommits. but
    // those are a necessary precontion for finalization, so
    // we can set them and display them in the ui.
    this.consensusCache[finalizedHeight][addr].Prevote = true;
    this.consensusCache[finalizedHeight][addr].Precommit = true;
  }

  public markImplicitlyFinalized(finalizedHeight: BlockNumber) {
    let addr = String(this.address);

    this.initialiseConsensusView(finalizedHeight, this.address);
    this.consensusCache[finalizedHeight][addr].Finalized = true;
    this.consensusCache[finalizedHeight][addr].FinalizedHeight = finalizedHeight;
    this.consensusCache[finalizedHeight][addr].ImplicitFinalized = true;

    // this is extrapolated. if this app was just started up we
    // might not yet have received prevotes/precommits. but
    // those are a necessary precontion for finalization, so
    // we can set them and display them in the ui.
    this.consensusCache[finalizedHeight][addr].Prevote = true;
    this.consensusCache[finalizedHeight][addr].Precommit = true;
    this.consensusCache[finalizedHeight][addr].ImplicitPrevote = true;
    this.consensusCache[finalizedHeight][addr].ImplicitPrecommit = true;
  }

  private onAfgReceivedPrecommit(message: AfgReceivedPrecommit) {
    const {
      target_number: targetNumber,
      target_hash: targetHash,
    } = message;
    const voter = this.extractVoter(message.voter);
    this.initialiseConsensusView(targetNumber as BlockNumber, voter);
    this.consensusCache[targetNumber as BlockNumber][voter].Precommit = true;

    // this node voted for this chain and all the blocks before the current
    // one as well. if there no commits yet registered for the prior block
    // close the gap to the last block by creating initial block objects.
    const mutate = (i: BlockNumber) => {
      const info = this.consensusCache[i][voter];
      if (info.Precommit || info.ImplicitPrecommit) {
        return false;
      }

      info.ImplicitPrecommit = true;
      info.ImplicitPointer = from;

      return true;
    };
    const from = targetNumber as BlockNumber;
    this.backfill(voter, from, mutate);

    this.events.emit('consensus-info');
  }

  private onAfgReceivedPrevote(message: AfgReceivedPrevote) {
    const {
      target_number: targetNumber,
      target_hash: targetHash,
    } = message;
    const voter = this.extractVoter(message.voter);
    this.initialiseConsensusView(targetNumber as BlockNumber, voter);
    this.consensusCache[targetNumber as BlockNumber][voter].Prevote = true;

    const firstBlockNumber = Object.keys(this.consensusCache)[0];
    const mutate = (i: BlockNumber) => {
      i = i as BlockNumber;
      const info = this.consensusCache[i][voter];
      if (info.Prevote || info.ImplicitPrevote) {
        return false;
      }

      this.consensusCache[i][voter].ImplicitPrevote = true;
      this.consensusCache[i][voter].ImplicitPointer = from;

      return true;
    };
    const from = targetNumber as BlockNumber;
    this.backfill(voter, from, mutate);

    this.events.emit('consensus-info');
  }

  private onAfgAuthoritySet(message: AfgAuthoritySet) {
    const {
      authority_set_id: authoritySetId,
      hash,
      number,
    } = message;

    // we manually parse the authorities message, because the array was formatted as a
    // string by substrate before sending it.
    let authorities = JSON.parse(String(message.authorities)) as Types.Authorities;

    if (JSON.stringify(this.authorities) !== String(message.authorities) ||
        this.authoritySetId !== authoritySetId) {
      this.events.emit('authority-set-changed', authorities, authoritySetId, number, hash);
    }

    this.authorities = authorities;
  }

  private onAfgFinalized(message: AfgFinalized) {
    const {
      finalized_number: finalizedNumber,
      finalized_hash: finalizedHash,
    } = message;

    this.markFinalized(finalizedNumber, finalizedHash);

    let to = finalizedNumber;
    this.backfill(this.address, to as BlockNumber, (i) => {
      i = i as BlockNumber;
      const info = this.consensusCache[i][String(this.address)];
      if (info.Finalized || info.ImplicitFinalized) {
        return false;
      }

      this.markImplicitlyFinalized(i);
      this.consensusCache[i][String(this.address)].ImplicitPointer = to;

      return true;
    });

    this.events.emit('consensus-info');
  }

  // fill the block cache back from the `to` number to the last block.
  // the function `f` is used to evaluate if we should continue backfilling.
  // `f` returns false when backfilling the cache should be stopped, true to continue.
  //
  // returns block number until which we backfilled
  private backfill(voter: Maybe<Types.Address>, from: BlockNumber, f: Maybe<(i: BlockNumber) => boolean>): BlockNumber {
    if (!voter) {
      return from;
    }

    // if this is the first block in the cache then we don't fill latter blocks
    if (Object.keys(this.consensusCache).length <= 1) {
      return from;
    }

    // if below this `from` there are not yet other blocks we don't create empty blocks
    if (!this.consensusCache[from - 1]) {
      return from;
    }

    const firstBlockNumber = Object.keys(this.consensusCache)[0];
    let cont = true;
    while (cont && from-- > 0) {
      if (this.consensusCache[from] !== undefined) {
        // we reached the next block prior to this
        return from;
      }

      this.initialiseConsensusView(from, voter);
      cont = f ? f(from) : true;

      let firstBlockReached = String(from) === firstBlockNumber;
      if (firstBlockReached) {
        break;
      }
    }
    return from;
  }

  private truncateBlockCache() {
    let list = Object.keys(this.consensusCache).reverse();
    list.map((k, i) => {
      if (i > MAX_BLOCKS_IN_NODE_CACHE + 1) {
        delete this.consensusCache[k];
      }
    });
  }

  private extractVoter(message_voter: String): Types.Address {
    return String(message_voter.replace(/"/g, '')) as Types.Address;
  }

  private updateLatency(now: Types.Timestamp) {
    // if (this.pingStart) {
    //   console.error(`${this.name} timed out on ping message.`);
    //   this.disconnect();
    //   return;
    // }

    this.pingStart = now;

    try {
      this.socket.ping(noop);
    } catch (err) {
      console.error('Failed to send ping to Node', err);

      this.disconnect();
    }
  }

  private updateBestBlock(update: BestBlock) {
    const { height, ts: time, best } = update;

    if (this.best.hash !== best && this.best.number <= height) {
      const blockTime = this.getBlockTime(time);

      this.best = new Block(height, best);
      this.blockTimestamp = timestamp();
      this.lastBlockAt = time;
      this.blockTimes.push(blockTime);
      this.blockTime = blockTime;

      if (blockTime > 100) {
        this.events.emit('block');
      } else if (!this.throttle) {
        this.throttle = true;

        setTimeout(() => {
          this.events.emit('block');
          this.throttle = false;
        }, 1000);
      }

      const target = this.best.number as BlockNumber;
      this.backfill(this.address, target, null);
    }
  }

  private getBlockTime(time: Date): Types.Milliseconds {
    if (!this.lastBlockAt) {
      return 0 as Types.Milliseconds;
    }

    return (+time - +this.lastBlockAt) as Types.Milliseconds;
  }
}
