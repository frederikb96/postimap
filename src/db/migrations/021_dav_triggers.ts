import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * DAV outbound-enqueue triggers, NOTIFY wakeups, and postimap_events payloads -- the same
 * shapes as 003_triggers.ts/004_events.ts, applied to the DAV tables. All skip when
 * `postimap.writer = 'sync'`, the same GUC the IMAP side already uses; there is only one
 * loop guard, not a second one per protocol.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // kind is denormalised onto dav_objects for its indexes, but a consumer's insert grant
  // is deliberately just (id, account_id, collection_id, data) -- naming kind a second
  // time would be one more place for it to disagree with the collection it is inserted
  // into. Derive it here instead, from the one place it is authoritative.
  await sql`
    CREATE OR REPLACE FUNCTION trg_dav_object_set_kind() RETURNS trigger AS $$
    BEGIN
      SELECT kind INTO NEW.kind FROM dav_collections WHERE id = NEW.collection_id;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_object_set_kind
      BEFORE INSERT ON dav_objects
      FOR EACH ROW
      EXECUTE FUNCTION trg_dav_object_set_kind()
  `.execute(db);

  // put: a consumer inserting a new object, or editing an existing one's body.
  await sql`
    CREATE OR REPLACE FUNCTION trg_dav_object_put() RETURNS trigger AS $$
    DECLARE writer text := COALESCE(current_setting('postimap.writer', true), '');
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;
      INSERT INTO dav_sync_queue (account_id, collection_id, object_id, action, payload)
      VALUES (NEW.account_id, NEW.collection_id, NEW.id, 'put',
        jsonb_build_object('href', NEW.href, 'etag', NEW.etag));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_object_put
      AFTER INSERT OR UPDATE OF data ON dav_objects
      FOR EACH ROW
      EXECUTE FUNCTION trg_dav_object_put()
  `.execute(db);

  // move: captures OLD collection/href/etag, the same reason message_move captures OLD --
  // the outbound processor needs to know where the object currently is on the server.
  // BEFORE rather than AFTER so it can null the etag: `etag IS NULL` is the consumer's
  // signal that the row is not yet where it says it is, the imap_uid IS NULL idiom.
  await sql`
    CREATE OR REPLACE FUNCTION trg_dav_object_move() RETURNS trigger AS $$
    DECLARE writer text := COALESCE(current_setting('postimap.writer', true), '');
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;
      IF OLD.collection_id IS DISTINCT FROM NEW.collection_id THEN
        INSERT INTO dav_sync_queue (account_id, collection_id, object_id, action, payload)
        VALUES (NEW.account_id, NEW.collection_id, NEW.id, 'move',
          jsonb_build_object(
            'from_collection_id', OLD.collection_id,
            'old_href', OLD.href,
            'old_etag', OLD.etag));
        NEW.etag := NULL;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_object_move
      BEFORE UPDATE OF collection_id ON dav_objects
      FOR EACH ROW
      EXECUTE FUNCTION trg_dav_object_move()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION trg_dav_object_delete() RETURNS trigger AS $$
    DECLARE writer text := COALESCE(current_setting('postimap.writer', true), '');
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        INSERT INTO dav_sync_queue (account_id, collection_id, object_id, action, payload)
        VALUES (NEW.account_id, NEW.collection_id, NEW.id, 'delete',
          jsonb_build_object('href', NEW.href, 'etag', NEW.etag));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_object_delete
      AFTER UPDATE OF deleted_at ON dav_objects
      FOR EACH ROW
      EXECUTE FUNCTION trg_dav_object_delete()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION trg_dav_collection_create() RETURNS trigger AS $$
    DECLARE writer text := COALESCE(current_setting('postimap.writer', true), '');
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;
      INSERT INTO dav_sync_queue (account_id, collection_id, action, payload)
      VALUES (NEW.account_id, NEW.id, 'mkcol',
        jsonb_build_object('kind', NEW.kind, 'slug', NEW.slug, 'display_name', NEW.display_name));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_collection_create
      AFTER INSERT ON dav_collections
      FOR EACH ROW
      EXECUTE FUNCTION trg_dav_collection_create()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION trg_dav_collection_props() RETURNS trigger AS $$
    DECLARE writer text := COALESCE(current_setting('postimap.writer', true), '');
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;
      INSERT INTO dav_sync_queue (account_id, collection_id, action, payload)
      VALUES (NEW.account_id, NEW.id, 'proppatch',
        jsonb_build_object('display_name', NEW.display_name, 'color', NEW.color,
          'description', NEW.description));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_collection_props
      AFTER UPDATE OF display_name, color, description ON dav_collections
      FOR EACH ROW
      EXECUTE FUNCTION trg_dav_collection_props()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION trg_dav_collection_delete() RETURNS trigger AS $$
    DECLARE writer text := COALESCE(current_setting('postimap.writer', true), '');
    BEGIN
      IF writer = 'sync' THEN
        RETURN NEW;
      END IF;
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        INSERT INTO dav_sync_queue (account_id, collection_id, action, payload)
        VALUES (NEW.account_id, NEW.id, 'rmcol', jsonb_build_object('href', NEW.href));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_collection_delete
      AFTER UPDATE OF deleted_at ON dav_collections
      FOR EACH ROW
      EXECUTE FUNCTION trg_dav_collection_delete()
  `.execute(db);

  // Internal wakeup for the DAV outbound processor -- same split as sync_queue vs
  // postimap_events.
  await sql`
    CREATE OR REPLACE FUNCTION notify_dav_sync_queue_insert() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify(
        'dav_sync_queue_' || NEW.account_id::text,
        json_build_object('id', NEW.id, 'action', NEW.action)::text
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_dav_sync_queue_notify
      AFTER INSERT ON dav_sync_queue
      FOR EACH ROW
      EXECUTE FUNCTION notify_dav_sync_queue_insert()
  `.execute(db);

  // Collection object count, delta formulation -- same shape as trg_folder_counts.
  await sql`
    CREATE OR REPLACE FUNCTION trg_dav_collection_counts() RETURNS trigger AS $$
    DECLARE
      old_vis int := 0;
      new_vis int := 0;
    BEGIN
      IF TG_OP IN ('UPDATE','DELETE') AND OLD.deleted_at IS NULL THEN
        old_vis := 1;
      END IF;
      IF TG_OP IN ('UPDATE','INSERT') AND NEW.deleted_at IS NULL THEN
        new_vis := 1;
      END IF;

      IF TG_OP = 'UPDATE' AND OLD.collection_id IS DISTINCT FROM NEW.collection_id THEN
        UPDATE dav_collections SET total_count = total_count - old_vis WHERE id = OLD.collection_id;
        UPDATE dav_collections SET total_count = total_count + new_vis WHERE id = NEW.collection_id;
      ELSIF (new_vis - old_vis) <> 0 THEN
        UPDATE dav_collections SET total_count = total_count + (new_vis - old_vis)
          WHERE id = COALESCE(NEW.collection_id, OLD.collection_id);
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_object_counts
      AFTER INSERT OR DELETE OR UPDATE OF collection_id, deleted_at
      ON dav_objects
      FOR EACH ROW
      EXECUTE FUNCTION trg_dav_collection_counts()
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_accounts_set_updated_at
      BEFORE UPDATE ON dav_accounts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_collections_set_updated_at
      BEFORE UPDATE ON dav_collections
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_objects_set_updated_at
      BEFORE UPDATE ON dav_objects
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `.execute(db);

  // postimap_events payloads. New `type` values on the existing channel rather than a
  // second one -- a consumer already listening to postimap_events sees these appear the
  // moment it upgrades, filtered out by `type` like everything else on the channel.
  await sql`
    CREATE OR REPLACE FUNCTION notify_dav_account_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
      changed text[] := '{}';
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'dav_account', 'op', 'delete', 'id', OLD.id,
          'account_id', OLD.id, 'origin', origin
        )::text);
        RETURN OLD;
      END IF;

      IF TG_OP = 'INSERT' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'dav_account', 'op', 'insert', 'id', NEW.id,
          'account_id', NEW.id, 'origin', origin
        )::text);
        RETURN NEW;
      END IF;

      IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN changed := array_append(changed, 'is_active'); END IF;
      IF OLD.state IS DISTINCT FROM NEW.state THEN changed := array_append(changed, 'state'); END IF;
      IF OLD.name IS DISTINCT FROM NEW.name THEN changed := array_append(changed, 'name'); END IF;

      IF array_length(changed, 1) IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'dav_account', 'op', 'update', 'id', NEW.id,
        'account_id', NEW.id, 'origin', origin, 'changed', to_jsonb(changed)
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_accounts_events
      AFTER INSERT OR DELETE OR UPDATE OF is_active, state, name
      ON dav_accounts
      FOR EACH ROW
      EXECUTE FUNCTION notify_dav_account_event()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION notify_dav_collection_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
      changed text[] := '{}';
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'dav_collection', 'op', 'delete', 'id', OLD.id,
          'account_id', OLD.account_id, 'collection_id', OLD.id, 'origin', origin
        )::text);
        RETURN OLD;
      END IF;

      IF TG_OP = 'INSERT' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'dav_collection', 'op', 'insert', 'id', NEW.id,
          'account_id', NEW.account_id, 'collection_id', NEW.id, 'origin', origin
        )::text);
        RETURN NEW;
      END IF;

      IF OLD.initial_sync_done IS DISTINCT FROM NEW.initial_sync_done AND NEW.initial_sync_done THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'dav_collection', 'op', 'sync_complete', 'id', NEW.id,
          'account_id', NEW.account_id, 'collection_id', NEW.id, 'origin', origin, 'backfill', true
        )::text);
        RETURN NEW;
      END IF;

      IF OLD.display_name IS DISTINCT FROM NEW.display_name THEN changed := array_append(changed, 'display_name'); END IF;
      IF OLD.color IS DISTINCT FROM NEW.color THEN changed := array_append(changed, 'color'); END IF;
      IF OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN changed := array_append(changed, 'deleted_at'); END IF;
      IF OLD.sync_error IS DISTINCT FROM NEW.sync_error THEN changed := array_append(changed, 'sync_error'); END IF;
      IF OLD.read_only IS DISTINCT FROM NEW.read_only THEN changed := array_append(changed, 'read_only'); END IF;
      IF OLD.backfill_total IS DISTINCT FROM NEW.backfill_total THEN changed := array_append(changed, 'backfill_total'); END IF;

      IF array_length(changed, 1) IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'dav_collection', 'op', 'update', 'id', NEW.id,
        'account_id', NEW.account_id, 'collection_id', NEW.id, 'origin', origin,
        'changed', to_jsonb(changed)
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_collections_events
      AFTER INSERT OR DELETE OR UPDATE OF
        display_name, color, deleted_at, initial_sync_done, sync_error, read_only, backfill_total
      ON dav_collections
      FOR EACH ROW
      EXECUTE FUNCTION notify_dav_collection_event()
  `.execute(db);

  // Per-row object events are suppressed under postimap.backfill = 'on', exactly as
  // message events are during a folder's first sync -- the collection's sync_complete
  // event is the one signal that fires instead.
  await sql`
    CREATE OR REPLACE FUNCTION notify_dav_object_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      backfill text := COALESCE(current_setting('postimap.backfill', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
      changed text[] := '{}';
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('postimap_events', jsonb_build_object(
          'v', 1, 'type', 'dav_object', 'op', 'delete', 'id', OLD.id,
          'account_id', OLD.account_id, 'collection_id', OLD.collection_id, 'origin', origin
        )::text);
        RETURN OLD;
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF backfill <> 'on' THEN
          PERFORM pg_notify('postimap_events', jsonb_build_object(
            'v', 1, 'type', 'dav_object', 'op', 'insert', 'id', NEW.id,
            'account_id', NEW.account_id, 'collection_id', NEW.collection_id, 'origin', origin
          )::text);
        END IF;
        RETURN NEW;
      END IF;

      IF backfill = 'on' THEN
        RETURN NEW;
      END IF;

      IF OLD.data IS DISTINCT FROM NEW.data THEN changed := array_append(changed, 'data'); END IF;
      IF OLD.collection_id IS DISTINCT FROM NEW.collection_id THEN
        changed := array_append(changed, 'collection_id');
      END IF;
      IF OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN changed := array_append(changed, 'deleted_at'); END IF;
      IF OLD.etag IS DISTINCT FROM NEW.etag THEN changed := array_append(changed, 'etag'); END IF;
      IF OLD.summary IS DISTINCT FROM NEW.summary THEN changed := array_append(changed, 'summary'); END IF;
      IF OLD.dtstart IS DISTINCT FROM NEW.dtstart THEN changed := array_append(changed, 'dtstart'); END IF;
      IF OLD.dtend IS DISTINCT FROM NEW.dtend THEN changed := array_append(changed, 'dtend'); END IF;
      IF OLD.status IS DISTINCT FROM NEW.status THEN changed := array_append(changed, 'status'); END IF;

      IF array_length(changed, 1) IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'dav_object', 'op', 'update', 'id', NEW.id,
        'account_id', NEW.account_id, 'collection_id', NEW.collection_id, 'origin', origin,
        'old_collection_id',
          CASE WHEN OLD.collection_id IS DISTINCT FROM NEW.collection_id THEN OLD.collection_id ELSE NULL END,
        'changed', to_jsonb(changed)
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_objects_events
      AFTER INSERT OR DELETE OR UPDATE OF
        data, collection_id, deleted_at, etag, summary, dtstart, dtend, status
      ON dav_objects
      FOR EACH ROW
      EXECUTE FUNCTION notify_dav_object_event()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION notify_dav_notification_event() RETURNS trigger AS $$
    DECLARE
      writer text := COALESCE(current_setting('postimap.writer', true), '');
      origin text := CASE WHEN writer = 'sync' THEN 'sync' ELSE 'app' END;
    BEGIN
      PERFORM pg_notify('postimap_events', jsonb_build_object(
        'v', 1, 'type', 'dav_notification', 'op', 'insert', 'id', NEW.id,
        'account_id', NEW.account_id, 'collection_id', NEW.collection_id,
        'action', NEW.action, 'origin', origin
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER dav_notifications_events
      AFTER INSERT ON dav_notifications
      FOR EACH ROW
      EXECUTE FUNCTION notify_dav_notification_event()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS dav_notifications_events ON dav_notifications`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_dav_notification_event()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_objects_events ON dav_objects`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_dav_object_event()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_collections_events ON dav_collections`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_dav_collection_event()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_accounts_events ON dav_accounts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_dav_account_event()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_objects_set_updated_at ON dav_objects`.execute(db);
  await sql`DROP TRIGGER IF EXISTS dav_collections_set_updated_at ON dav_collections`.execute(db);
  await sql`DROP TRIGGER IF EXISTS dav_accounts_set_updated_at ON dav_accounts`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_object_counts ON dav_objects`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_dav_collection_counts()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS trg_dav_sync_queue_notify ON dav_sync_queue`.execute(db);
  await sql`DROP FUNCTION IF EXISTS notify_dav_sync_queue_insert()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_collection_delete ON dav_collections`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_dav_collection_delete()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_collection_props ON dav_collections`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_dav_collection_props()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_collection_create ON dav_collections`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_dav_collection_create()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_object_delete ON dav_objects`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_dav_object_delete()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_object_move ON dav_objects`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_dav_object_move()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_object_put ON dav_objects`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_dav_object_put()`.execute(db);

  await sql`DROP TRIGGER IF EXISTS dav_object_set_kind ON dav_objects`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_dav_object_set_kind()`.execute(db);
}
