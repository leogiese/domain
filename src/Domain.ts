import { isBrowser } from "./env";
import { Actor } from "./Actor";
import { Observer } from "@cqrsfk/ob";
import { Change } from "@cqrsfk/ob-middle-change";
import { Sync, Synchronizer } from "@cqrsfk/ob-middle-sync";
import { OBMiddle } from "./ob-middle";
import { Context } from "./Context";
import { Saga } from "./Saga";
import { Event } from "./types/Event";
import { getAlias } from "./eventAlias";
import { EventEmitter } from "events";
import sleep from "sleep-promise";
import uid from "shortid";
import { publish } from "./publish";
import { updater } from "./updater";


if (!isBrowser) {
  var lockfile = require("proper-lockfile");
  var { writeFileSync, mkdirSync, readdirSync, readFileSync } = require("fs");
}

export class Domain {
  private TypeMap = new Map<string, typeof Actor>();
  private TypeDBMap = new Map<string, PouchDB.Database>();
  private db: PouchDB.Database;
  private eventsBuffer: Event[] = [];
  private bus = new EventEmitter();

  private isSync = false;

  public localBus = new EventEmitter();
  private publishing = false;
  readonly id;
  private readonly name: string;
  private actorBuffer = new Map<string, Actor>();

  private processInfo: { sagaIds: string[] } = {
    sagaIds: []
  };

  constructor({ name, db }: { name: string; db: PouchDB.Database }) {
    this.db = db;
    this.name = name;
    this.id = uid();
    this.reg = this.reg.bind(this);
    this.create = this.create.bind(this);
    this.get = this.get.bind(this);
    this.localGet = this.localGet.bind(this);
    this.find = this.find.bind(this);
    this.findRows = this.findRows.bind(this);

    if (!isBrowser) {
      try {
        mkdirSync(name);
      } catch (err) { }
      // TODO:  find unlock lock's files  
      const locknames = readdirSync(name);
      for (let n of locknames) {
        if (!lockfile.checkSync(name + "/" + n)) {
          lockfile.lockSync(name + "/" + n);

          // handle unfinish sagas
          const buf = readFileSync(name + "/" + n, "utf8");
          const json = JSON.parse(buf);
          const sagaIds = json.sagaIds as string[];

          for (let typeid of sagaIds) {
            const [type, id] = typeid.split(".");
            this.recoverSaga(type, id);
          }
        }
      }

      writeFileSync(name + "/" + this.id, JSON.stringify(this.processInfo));
      lockfile.lockSync(name + "/" + this.id);

    }

    // this.changeHandle = this.changeHandle.bind(this);
    // db.changes({
    //   since: "now",
    //   live: true,
    //   include_docs: true
    // }).on("change", this.changeHandle);

    // writeFileSync(this.id,JSON.stringify());
  }

  private async recoverSaga(type, id) {
    const saga = await this.get<Saga>(type, id);
    if (saga) {
      await saga.recover();
    }
  }

  enableSync() {
    if (!this.isSync) {
      this.isSync = true;
      this.actorBuffer = new Map<string, Actor>();
    }
  }

  disableSync() {
    if (this.isSync) {
      this.isSync = false;
    }
  }

  reg<T extends typeof Actor>(Type: T, db?: PouchDB.Database) {
    this.TypeMap.set(Type.type, Type);

    if (!isBrowser) {
      if (Type.prototype instanceof Saga) {
        this.on({ actor: Type.type, type: "created" }, (event: Event) => {
          this.processInfo.sagaIds.push(event.actorType + "." + event.actorId);
          writeFileSync(
            this.name + "/" + this.id,
            JSON.stringify(this.processInfo)
          );
        });

        this.on({ actor: Type.type, type: "finish" }, (event: Event) => {
          const sagaIds = new Set(this.processInfo.sagaIds);
          sagaIds.delete(event.actorType + "." + event.actorId);
          this.processInfo.sagaIds = [...sagaIds];
          writeFileSync(
            this.name + "/" + this.id,
            JSON.stringify(this.processInfo)
          );
        });
      }
    }

    if (db) {
      this.TypeDBMap.set(Type.type, db);
      // db.changes({
      //   since: "now",
      //   live: true,
      //   include_docs: true
      // }).on("change", this.changeHandle);
    }
  }

  async create<T extends Actor>(type: string, argv: any[], isSync?: boolean) {
    const Type = this.TypeMap.get(type);
    if (Type) {
      Type.beforeCreate && (await Type.beforeCreate(argv));
      const actor = new Type(...argv);

      const proxy = (isSync || this.isSync) ? this.proxy(actor) : actor;

      this.actorBuffer.set(actor._id, proxy);
      const p = this.observe<T>(proxy);
      await p.save(true);
      const e: Event = {
        id: uid(),
        type: "created",
        data: actor.json,
        actorId: actor._id,
        actorType: actor.$type,
        actorVersion: actor.$version,
        actorRev: actor._rev,
        createTime: Date.now()
      };
      publish([e], this.localBus);

      return p;
    } else throw new Error(type + " type no exist ! ");
  }

  private changeHandle({
    doc,
    deleted
  }: PouchDB.Core.ChangesResponseChange<Actor>) {
    if (doc) {
      const { _rev, $type, $events, $version, _id } = doc;
      const pn = _rev.split("-")[0];
      if (pn === "1") {
        const createEvent: Event = {
          id: uid(),
          type: "created",
          data: doc,
          actorId: _id,
          actorType: $type,
          actorVersion: $version,
          actorRev: _rev,
          createTime: Date.now()
        };
        this.eventsBuffer.push(createEvent);
      } else if (deleted) {
        const deleteEvent: Event = {
          id: uid(),
          type: "deleted",
          data: doc,
          actorId: _id,
          actorType: $type,
          actorVersion: $version,
          actorRev: _rev,
          createTime: Date.now()
        };
        this.eventsBuffer.push(deleteEvent);
      } else {
        this.eventsBuffer.push(...$events);
      }

      this.publish();
    }
  }

  async publish() {
    if (this.publishing) {
      return;
    }
    this.publishing = true;
    const event = this.eventsBuffer.shift();
    if (event) {
      const eventNames = getAlias(event);
      eventNames.forEach(e => {
        this.bus.emit(e, event);
      });
      await sleep(0);
      this.publishing = false;
      await this.publish();
    } else {
      this.publishing = false;
    }
  }

  addEventListener(
    event:
      | {
        actor?: string;
        type?: string;
        id?: string;
      }
      | string,
    listener: any,
    { local = false, once = false }: { local: boolean; once: boolean } = {
      local: false,
      once: false
    }
  ) {
    let eventname;
    const bus = local ? this.localBus : this.bus;
    if (typeof event === "string") eventname = event;
    else eventname = this.getEventName(event);
    if (once) bus.once(eventname, listener);
    else bus.on(eventname, listener);
  }

  on(
    event:
      {
        actor?: string;
        type?: string;
        id?: string;
      }
      | string,
    listener,
    local: boolean = true
  ) {
    this.addEventListener(event, listener, { once: false, local });
  }

  once(
    event:
      {
        actor?: string;
        type?: string;
        id?: string;
      }
      | string,
    listener,
    local: boolean = true
  ) {
    this.addEventListener(event, listener, { once: true, local });
  }

  getEventName({
    actor = "",
    type = "",
    id = ""
  }: {
      actor?: string;
      type?: string;
      id?: string;
    }) {
    return `${actor}.${id}.${type}`;
  }

  removeListener(eventname, listener) {
    this.bus.removeListener(eventname, listener);
  }
  removeAllListeners(eventname?: string) {
    this.bus.removeAllListeners(eventname);
  }

  /**
   * TODO:  
   * @param actor
   * @param holderId
   */
  private observe<T extends Actor>(
    actor: Actor,
    holderId?: string,
    recoverEventId = ""
  ) {
    const ob = new Observer<T>(actor);
    const { proxy, use } = ob;
    const cxt = new Context(this.TypeDBMap.get(actor.$type) || this.db, proxy, this);
    use(new OBMiddle(cxt, holderId, recoverEventId));
    return proxy;
  }

  async get<T extends Actor>(
    type: string,
    id: string,
    isSync?: boolean
  ) {
    return this.localGet<T>(type, id, "", "", isSync);
  }

  async localGet<T extends Actor>(
    type: string,
    id: string,
    holderId?: string,
    recoverEventId = "",
    isSync = false
  ) {


    let proxy = this.actorBuffer.get(id) as Actor;

    if (!proxy) {
      const actor = await this.nativeGet<T>(type, id);
      if (actor) {
        proxy = (isSync || this.isSync) ? this.proxy(actor) : actor;
        this.actorBuffer.set(actor._id, proxy);
      } else {
        return null;
      }
    }

    return this.observe<T>(proxy, holderId, recoverEventId) as T;

  }


  private proxy(actor: Actor) {
    const ob = new Observer<Synchronizer>(actor, "cqrs");
    ob.use(Change);
    ob.use(Sync);
    const proto = actor.clone();
    const unsubscribe = ob.proxy.$sync(updater(proto, data => {
      const e: Event = {
        id: uid(),
        type: "$change",
        data,
        actorId: data._id,
        actorType: data.$type,
        actorVersion: data.$version,
        actorRev: data._rev,
        createTime: Date.now()
      };
      publish([e], this.localBus);
    }));
    return ob.proxy as Actor;
  }

  private async nativeGet<T extends Actor>(
    type: string,
    id: string
  ): Promise<T | null> {
    // const doc = this.actorBuffer.get(id);
    // if (doc) return doc;
    const Type = this.TypeMap.get(type);
    if (Type) {
      const db = this.TypeDBMap.get(Type.type) || this.db;
      const row = await db.get(id);
      if (row) {
        const actor = Type.parse(row);
        return actor as T;
      }
      return null;
    } else throw new Error(type + " type no exist ! ");
  }

  async findRows(
    type: string,
    params: PouchDB.Find.FindRequest<{}>
  ): Promise<any[]> {

    const newParams = { ...params, selector: { ...params.selector, $type: type } };

    const Type = this.TypeMap.get(type);
    if (Type) {
      const db = this.TypeDBMap.get(Type.type) || this.db;
      let fields;
      if (newParams.sort) {
        fields = newParams.sort.map(p => typeof p === "string" ? p : Object.keys(p)[0])
      }

      fields && await db.createIndex({
        index: {
          fields
        }
      });
      const { docs } = await db.find(newParams);
      return docs;
    } else throw new Error(type + " type no exist ! ");
  }

  async find<T extends Actor>(
    type: string,
    params: PouchDB.Find.FindRequest<{}>
  ): Promise<T[]> {
    const Type = this.TypeMap.get(type);
    if (Type) {
      const docs = await this.findRows(type, params);
      return docs.map(doc => {
        const actor = Type.parse(doc);
        return this.observe<T>(actor);
      });
    } else throw new Error(type + " type no exist ! ");
  }
}
