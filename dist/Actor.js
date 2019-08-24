"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const uid = require("shortid");
const lodash_1 = require("lodash");
const sleep = require("sleep-promise");
const History_1 = require("./History");
require("reflect-metadata");
class Actor {
    constructor(...argv) {
        this._id = uid();
        this._deleted = false;
        this.$events = [];
        this.$listeners = {};
        this.$type = this.statics.type;
        this.$version = this.statics.version;
    }
    static beforeCreate(argv) { }
    static created(actor) { }
    static get type() {
        return this.name;
    }
    static json(actor) {
        return JSON.parse(JSON.stringify(actor));
    }
    static parse(json) {
        json = lodash_1.cloneDeep(json);
        json.__proto__ = this.prototype;
        json.constructor = this;
        return json;
    }
    get statics() {
        return this.constructor;
    }
    get json() {
        return this.statics.json(this);
    }
    async save(force = false) {
        if (!force && !this.$events.length)
            return;
        if (this.beforeSave) {
            await this.beforeSave();
        }
        for (let evt of this.$events) {
            const l = this.$listeners[evt.type];
            if (l) {
                for (let id in l) {
                    const handles = l[id];
                    for (let h of handles) {
                        const [type, id, method] = h.split(".");
                        const act = await this.$cxt.get(type, id);
                        await act[method](evt);
                    }
                }
            }
        }
        const json = this.json;
        let result = await this.$cxt.db.put(json);
        this._rev = result.rev;
        this.$events = [];
        await sleep(10);
        if (this.afterSave) {
            await this.afterSave();
        }
        return result;
    }
    async subscribe({ event, type, id, method }) {
        let l = this.$listeners[event];
        if (!l) {
            l = this.$listeners[event] = {};
        }
        if (!l[id]) {
            l[id] = [];
        }
        const lset = new Set(l[id]);
        lset.add(`${type}.${id}.${method}`);
        l[id] = [...lset];
        return await this.save(true);
    }
    async unsubscribe({ event, type, id, method }) {
        const l = this.$listeners[event];
        if (l && l[id]) {
            const lset = new Set(l[id]);
            lset.delete(`${type}.${id}.${method}`);
            l[id] = [...lset];
            return await this.save(true);
        }
    }
    async history() {
        const row = await this.$cxt.db.get(this._id, {
            revs: true
        });
        let protoActor = this;
        const events = [];
        if (row._revisions) {
            let start = row._revisions.start;
            let ids = row._revisions.ids.reverse();
            for (let i = 0; i < start; i++) {
                const item = await this.$cxt.db.get(this._id, {
                    rev: i + 1 + "-" + ids[i]
                });
                events.push(...item.$events);
                if (i === 0)
                    protoActor = this.statics.parse(item);
            }
        }
        events.push(...this.$events);
        const history = new History_1.History(protoActor, events);
        return history;
    }
    async refresh() {
        const latestJSON = await this.$cxt.db.get("mydoc");
        if (latestJSON._rev === this._rev)
            return;
        const latestActor = this.statics.parse(latestJSON);
        for (let k in latestActor) {
            if (latestActor.hasOwnProperty(k)) {
                this[k] = latestActor[k];
            }
        }
    }
    removed(rev) {
        this._deleted = true;
        this._rev = rev;
    }
    async remove() {
        if (this._rev) {
            this.beforeRemove && (await this.beforeRemove());
            const result = await this.$cxt.db.remove(this._id, this._rev);
            this.$cxt.apply("removed", result.rev);
            this.afterRemove && (await this.afterRemove());
            return result;
        }
    }
    $updater(event) {
        const changers = Reflect.getMetadata("changers", this.constructor) || {};
        const mutations = Reflect.getMetadata("mutations", this.constructor) || {};
        const method = changers[event.type];
        if (method && this[method]) {
            return this[method](event);
        }
        else {
            for (let method in mutations) {
                let v = mutations[method];
                if (v.event === event.type) {
                    return this[method](...event.data);
                }
            }
        }
    }
}
Actor.version = 1.0;
exports.Actor = Actor;
//# sourceMappingURL=Actor.js.map