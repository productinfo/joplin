import { BaseModel } from 'lib/base-model.js';
import { Database } from 'lib/database.js';
import { time } from 'lib/time-utils.js';
import { sprintf } from 'sprintf-js';
import moment from 'moment';

class BaseItem extends BaseModel {

	static useUuid() {
		return true;
	}

	static loadClass(className, classRef) {
		for (let i = 0; i < BaseItem.syncItemDefinitions_.length; i++) {
			if (BaseItem.syncItemDefinitions_[i].className == className) {
				BaseItem.syncItemDefinitions_[i].classRef = classRef;
				return;
			}
		}

		throw new Error('Invalid class name: ' + className);
	}

	// Need to dynamically load the classes like this to avoid circular dependencies
	static getClass(name) {
		for (let i = 0; i < BaseItem.syncItemDefinitions_.length; i++) {
			if (BaseItem.syncItemDefinitions_[i].className == name) {
				return BaseItem.syncItemDefinitions_[i].classRef;
			}
		}

		throw new Error('Invalid class name: ' + name);
	}

	static async syncedCount(syncTarget) {
		const ItemClass = this.itemClass(this.modelType());
		const itemType = ItemClass.modelType();
		// The fact that we don't check if the item_id still exist in the corresponding item table, means
		// that the returned number might be innaccurate (for example if a sync operation was cancelled)
		const sql = 'SELECT count(*) as total FROM sync_items WHERE sync_target = ? AND item_type = ?';
		const r = await this.db().selectOne(sql, [ syncTarget, itemType ]);
		return r.total;
	}

	static systemPath(itemOrId) {
		if (typeof itemOrId === 'string') return itemOrId + '.md';
		return itemOrId.id + '.md';
	}

	static itemClass(item) {
		if (!item) throw new Error('Item cannot be null');

		if (typeof item === 'object') {
			if (!('type_' in item)) throw new Error('Item does not have a type_ property');
			return this.itemClass(item.type_);
		} else {
			for (let i = 0; i < BaseItem.syncItemDefinitions_.length; i++) {
				let d = BaseItem.syncItemDefinitions_[i];
				if (Number(item) == d.type) return this.getClass(d.className);
			}
			throw new Error('Unknown type: ' + item);
		}
	}

	// Returns the IDs of the items that have been synced at least once
	static async syncedItems(syncTarget) {
		if (!syncTarget) throw new Error('No syncTarget specified');
		return await this.db().selectAll('SELECT item_id, item_type FROM sync_items WHERE sync_time > 0 AND sync_target = ?', [syncTarget]);
	}

	static pathToId(path) {
		let s = path.split('.');
		return s[0];
	}

	static loadItemByPath(path) {
		return this.loadItemById(this.pathToId(path));
	}

	static async loadItemById(id) {
		let classes = this.syncItemClassNames();
		for (let i = 0; i < classes.length; i++) {
			let item = await this.getClass(classes[i]).load(id);
			if (item) return item;
		}
		return null;
	}

	static loadItemByField(itemType, field, value) {
		let ItemClass = this.itemClass(itemType);
		return ItemClass.loadByField(field, value);
	}

	static loadItem(itemType, id) {
		let ItemClass = this.itemClass(itemType);
		return ItemClass.load(id);
	}

	static deleteItem(itemType, id) {
		let ItemClass = this.itemClass(itemType);
		return ItemClass.delete(id);
	}

	static async delete(id, options = null) {
		return this.batchDelete([id], options);
	}

	static async batchDelete(ids, options = null) {
		let trackDeleted = true;
		if (options && options.trackDeleted !== null && options.trackDeleted !== undefined) trackDeleted = options.trackDeleted;

		// Don't create a deleted_items entry when conflicted notes are deleted
		// since no other client have (or should have) them.
		let conflictNoteIds = [];
		if (this.modelType() == BaseModel.TYPE_NOTE) {
			const conflictNotes = await this.db().selectAll('SELECT id FROM notes WHERE id IN ("' + ids.join('","') + '") AND is_conflict = 1');
			conflictNoteIds = conflictNotes.map((n) => { return n.id });
		}

		await super.batchDelete(ids, options);

		if (trackDeleted) {
			let queries = [];
			let now = time.unixMs();
			for (let i = 0; i < ids.length; i++) {
				if (conflictNoteIds.indexOf(ids[i]) >= 0) continue;

				queries.push({
					sql: 'INSERT INTO deleted_items (item_type, item_id, deleted_time) VALUES (?, ?, ?)',
					params: [this.modelType(), ids[i], now],
				});
			}
			await this.db().transactionExecBatch(queries);
		}
	}

	static deletedItems() {
		return this.db().selectAll('SELECT * FROM deleted_items');
	}

	static async deletedItemCount() {
		let r = await this.db().selectOne('SELECT count(*) as total FROM deleted_items');
		return r['total'];
	}

	static remoteDeletedItem(itemId) {
		return this.db().exec('DELETE FROM deleted_items WHERE item_id = ?', [itemId]);
	}

	static serialize_format(propName, propValue) {
		if (['created_time', 'updated_time', 'sync_time'].indexOf(propName) >= 0) {
			if (!propValue) return '';
			propValue = moment.unix(propValue / 1000).utc().format('YYYY-MM-DDTHH:mm:ss.SSS') + 'Z';
		} else if (propValue === null || propValue === undefined) {
			propValue = '';
		}

		return propValue;
	}

	static unserialize_format(type, propName, propValue) {
		if (propName[propName.length - 1] == '_') return propValue; // Private property

		let ItemClass = this.itemClass(type);

		if (['created_time', 'updated_time'].indexOf(propName) >= 0) {
			if (!propValue) return 0;
			propValue = moment(propValue, 'YYYY-MM-DDTHH:mm:ss.SSSZ').format('x');
		} else {
			propValue = Database.formatValue(ItemClass.fieldType(propName), propValue);
		}

		return propValue;
	}

	static async serialize(item, type = null, shownKeys = null) {
		item = this.filter(item);

		let output = {};

		if ('title' in item && shownKeys.indexOf('title') >= 0) {
			output.title = item.title;
		}

		if ('body' in item && shownKeys.indexOf('body') >= 0) {
			output.body = item.body;
		}

		output.props = [];

		for (let i = 0; i < shownKeys.length; i++) {
			let key = shownKeys[i];
			if (key == 'title' || key == 'body') continue;

			let value = null;
			if (typeof key === 'function') {
				let r = await key();
				key = r.key;
				value = r.value;
			} else {
				value = this.serialize_format(key, item[key]);
			}

			output.props.push(key + ': ' + value);
		}

		let temp = [];

		if (output.title) temp.push(output.title);
		if (output.body) temp.push(output.body);
		if (output.props.length) temp.push(output.props.join("\n"));

		return temp.join("\n\n");
	}

	static async unserialize(content) {
		let lines = content.split("\n");
		let output = {};
		let state = 'readingProps';
		let body = [];

		for (let i = lines.length - 1; i >= 0; i--) {
			let line = lines[i];

			if (state == 'readingProps') {
				line = line.trim();

				if (line == '') {
					state = 'readingBody';
					continue;
				}

				let p = line.indexOf(':');
				if (p < 0) throw new Error('Invalid property format: ' + line + ": " + content);
				let key = line.substr(0, p).trim();
				let value = line.substr(p + 1).trim();
				output[key] = value;
			} else if (state == 'readingBody') {
				body.splice(0, 0, line);
			}
		}

		if (!output.type_) throw new Error('Missing required property: type_: ' + content);
		output.type_ = Number(output.type_);

		if (body.length) {
			let title = body.splice(0, 2);
			output.title = title[0];
		}

		if (body.length) output.body = body.join("\n");

		for (let n in output) {
			if (!output.hasOwnProperty(n)) continue;
			output[n] = await this.unserialize_format(output.type_, n, output[n]);
		}

		return output;
	}

	static async itemsThatNeedSync(syncTarget, limit = 100) {
		const classNames = this.syncItemClassNames();

		for (let i = 0; i < classNames.length; i++) {
			const className = classNames[i];
			const ItemClass = this.getClass(className);
			const fieldNames = ItemClass.fieldNames(true);
			fieldNames.push('sync_time');

			let extraWhere = className == 'Note' ? 'AND is_conflict = 0' : '';

			let sql = sprintf(`
				SELECT %s FROM %s
				LEFT JOIN sync_items t ON t.item_id = %s.id
				WHERE 
					(t.id IS NULL OR t.sync_time < %s.updated_time)
					%s
				LIMIT %d
			`,
			this.db().escapeFields(fieldNames),
			this.db().escapeField(ItemClass.tableName()),
			this.db().escapeField(ItemClass.tableName()),
			this.db().escapeField(ItemClass.tableName()),
			extraWhere,
			limit);

			const items = await ItemClass.modelSelectAll(sql);

			if (i >= classNames.length - 1) {
				return { hasMore: items.length >= limit, items: items };
			} else {
				if (items.length) return { hasMore: true, items: items };
			}
		}

		throw new Error('Unreachable');
	}

	static syncItemClassNames() {
		return BaseItem.syncItemDefinitions_.map((def) => {
			return def.className;
		});
	}

	static modelTypeToClassName(type) {
		for (let i = 0; i < BaseItem.syncItemDefinitions_.length; i++) {
			if (BaseItem.syncItemDefinitions_[i].type == type) return BaseItem.syncItemDefinitions_[i].className;
		}
		throw new Error('Invalid type: ' + type);
	}

	static updateSyncTimeQueries(syncTarget, item, syncTime) {
		const itemType = item.type_;
		const itemId = item.id;
		if (!itemType || !itemId || syncTime === undefined) throw new Error('Invalid parameters in updateSyncTimeQueries()');

		return [
			{
				sql: 'DELETE FROM sync_items WHERE sync_target = ? AND item_type = ? AND item_id = ?',
				params: [syncTarget, itemType, itemId],
			},
			{
				sql: 'INSERT INTO sync_items (sync_target, item_type, item_id, sync_time) VALUES (?, ?, ?, ?)',
				params: [syncTarget, itemType, itemId, syncTime],
			}
		];
	}

	static async saveSyncTime(syncTarget, item, syncTime) {
		const queries = this.updateSyncTimeQueries(syncTarget, item, syncTime);
		return this.db().transactionExecBatch(queries);
	}

	static async deleteOrphanSyncItems() {
		const classNames = this.syncItemClassNames();

		let queries = [];
		for (let i = 0; i < classNames.length; i++) {
			const className = classNames[i];
			const ItemClass = this.getClass(className);

			let selectSql = 'SELECT id FROM ' + ItemClass.tableName();
			if (ItemClass.modelType() == this.TYPE_NOTE) selectSql += ' WHERE is_conflict = 0';

			queries.push('DELETE FROM sync_items WHERE item_type = ' + ItemClass.modelType() + ' AND item_id NOT IN (' + selectSql + ')');
		}

		await this.db().transactionExecBatch(queries);
	}

}

// Also update:
// - itemsThatNeedSync()
// - syncedItems()

BaseItem.syncItemDefinitions_ = [
	{ type: BaseModel.TYPE_NOTE, className: 'Note' },
	{ type: BaseModel.TYPE_FOLDER, className: 'Folder' },
	{ type: BaseModel.TYPE_RESOURCE, className: 'Resource' },
	{ type: BaseModel.TYPE_TAG, className: 'Tag' },
	{ type: BaseModel.TYPE_NOTE_TAG, className: 'NoteTag' },
];

export { BaseItem };