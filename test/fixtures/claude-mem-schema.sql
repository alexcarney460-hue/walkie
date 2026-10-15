CREATE TABLE schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      );
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
        created_at_epoch INTEGER NOT NULL, agent_type TEXT, agent_id TEXT, tool_use_id TEXT,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      );
CREATE INDEX idx_pending_messages_session ON pending_messages(session_db_id);
CREATE INDEX idx_pending_messages_status ON pending_messages(status);
CREATE INDEX idx_pending_messages_claude_session ON pending_messages(content_session_id);
CREATE TABLE IF NOT EXISTS "observations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL, content_hash TEXT, generated_by_model TEXT, relevance_count INTEGER DEFAULT 0, merged_into_project TEXT, agent_type TEXT, agent_id TEXT, metadata TEXT, synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT, sync_rev TEXT NOT NULL DEFAULT '1', occurrence_count INTEGER NOT NULL DEFAULT 1, title_norm_key TEXT, reinforcement_dates TEXT, last_reinforced TEXT,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );
CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
CREATE INDEX idx_observations_project ON observations(project);
CREATE INDEX idx_observations_type ON observations(type);
CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
CREATE TABLE IF NOT EXISTS "session_summaries" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL, merged_into_project TEXT, synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT, sync_rev TEXT NOT NULL DEFAULT '1',
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );
CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
CREATE INDEX idx_session_summaries_project ON session_summaries(project);
CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
CREATE INDEX idx_observations_content_hash ON observations(content_hash, created_at_epoch);
CREATE INDEX idx_observations_merged_into ON observations(merged_into_project);
CREATE INDEX idx_summaries_merged_into ON session_summaries(merged_into_project);
CREATE INDEX idx_observations_agent_type ON observations(agent_type);
CREATE INDEX idx_observations_agent_id ON observations(agent_id);
CREATE UNIQUE INDEX ux_observations_session_hash
        ON observations(memory_session_id, content_hash)
      ;
CREATE VIRTUAL TABLE observations_fts USING fts5(
        title,
        subtitle,
        narrative,
        text,
        facts,
        concepts,
        content='observations',
        content_rowid='id'
      )
/* observations_fts(title,subtitle,narrative,text,facts,concepts) */;
CREATE TABLE IF NOT EXISTS 'observations_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE IF NOT EXISTS 'observations_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'observations_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'observations_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END;
CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
        request,
        investigated,
        learned,
        completed,
        next_steps,
        notes,
        content='session_summaries',
        content_rowid='id'
      )
/* session_summaries_fts(request,investigated,learned,completed,next_steps,notes) */;
CREATE TABLE IF NOT EXISTS 'session_summaries_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE IF NOT EXISTS 'session_summaries_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'session_summaries_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'session_summaries_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TRIGGER session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;
CREATE TRIGGER session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      END;
CREATE TABLE IF NOT EXISTS "sdk_sessions" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
        worker_port INTEGER,
        prompt_counter INTEGER DEFAULT 0,
        custom_title TEXT
      , observed_model TEXT, observed_billing TEXT, cwd TEXT, project_key_source TEXT);
CREATE INDEX idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
CREATE INDEX idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
CREATE INDEX idx_sdk_sessions_project ON sdk_sessions(project);
CREATE INDEX idx_sdk_sessions_status ON sdk_sessions(status);
CREATE INDEX idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);
CREATE INDEX idx_sdk_sessions_platform_source ON sdk_sessions(platform_source);
CREATE UNIQUE INDEX ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id);
CREATE TABLE IF NOT EXISTS "user_prompts" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL, synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT, sync_rev TEXT NOT NULL DEFAULT '1',
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      );
CREATE INDEX idx_user_prompts_session ON user_prompts(session_db_id);
CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
CREATE INDEX idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number);
CREATE INDEX idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number);
CREATE UNIQUE INDEX ux_pending_session_tool
      ON pending_messages(session_db_id, tool_use_id)
      WHERE tool_use_id IS NOT NULL
    ;
CREATE INDEX idx_observations_unsynced ON observations(id) WHERE synced_at IS NULL;
CREATE INDEX idx_session_summaries_unsynced ON session_summaries(id) WHERE synced_at IS NULL;
CREATE INDEX idx_user_prompts_unsynced ON user_prompts(id) WHERE synced_at IS NULL;
CREATE UNIQUE INDEX ux_observations_origin
        ON observations(origin_device_id, origin_local_id)
        WHERE origin_device_id IS NOT NULL
      ;
CREATE UNIQUE INDEX ux_session_summaries_origin
        ON session_summaries(origin_device_id, origin_local_id)
        WHERE origin_device_id IS NOT NULL
      ;
CREATE UNIQUE INDEX ux_user_prompts_origin
        ON user_prompts(origin_device_id, origin_local_id)
        WHERE origin_device_id IS NOT NULL
      ;
CREATE TABLE sync_state (
        k TEXT PRIMARY KEY,
        v TEXT
      );
CREATE TABLE sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_uuid TEXT NOT NULL UNIQUE,
        rev TEXT NOT NULL DEFAULT '1',
        body TEXT NOT NULL,
        canonical_body TEXT,
        operation_sha256 TEXT,
        created_at_epoch INTEGER NOT NULL
      );
CREATE TABLE sync_entity_heads (
        entity_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_device_id TEXT NOT NULL,
        origin_local_id TEXT NOT NULL,
        entity_rev TEXT NOT NULL,
        operation_sha256 TEXT NOT NULL,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        updated_at_epoch INTEGER NOT NULL
      );
CREATE TABLE sync_content_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_local_id TEXT NOT NULL,
        entity_rev TEXT NOT NULL,
        body TEXT NOT NULL,
        operation_sha256 TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(entity_id, entity_rev)
      );
CREATE TABLE sync_dead_letter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lane TEXT NOT NULL CHECK (lane IN ('content', 'mutation')),
        queue_key TEXT NOT NULL,
        kind TEXT,
        origin_local_id TEXT,
        entity_rev TEXT,
        reason TEXT NOT NULL,
        raw_body TEXT,
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(lane, queue_key, entity_rev, reason)
      );
CREATE TABLE sync_launch_exclusions (
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_local_id TEXT NOT NULL,
        through_rev TEXT NOT NULL,
        PRIMARY KEY (kind, origin_local_id)
      );
CREATE TABLE tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT,
      session_db_id INTEGER,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude',
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      prompt_number INTEGER,
      agent_type TEXT,
      agent_id TEXT,
      observation_id INTEGER,
      or_generation_id TEXT,
      or_session_id TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      UNIQUE(content_session_id, tool_use_id)
    );
CREATE INDEX idx_tool_uses_project ON tool_uses(project);
CREATE INDEX idx_tool_uses_memory_session ON tool_uses(memory_session_id);
CREATE INDEX idx_tool_uses_content_session ON tool_uses(content_session_id);
CREATE INDEX idx_tool_uses_session_db_id ON tool_uses(session_db_id);
CREATE INDEX idx_tool_uses_tool_name ON tool_uses(tool_name);
CREATE INDEX idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch);
CREATE INDEX idx_tool_uses_observation_id ON tool_uses(observation_id);
CREATE INDEX idx_tool_uses_or_generation_id ON tool_uses(or_generation_id);
CREATE TABLE file_context_injections (
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    observation_epoch INTEGER NOT NULL,
    injected_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (session_id, file_path)
  );
CREATE TABLE telegram_wrapups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_source TEXT NOT NULL,
        content_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        route_key TEXT NOT NULL,
        summary_created_at_epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('claimed', 'sent')),
        claimed_at_epoch INTEGER NOT NULL,
        sent_at_epoch INTEGER,
        UNIQUE(platform_source, content_session_id, project, route_key)
      );
CREATE INDEX idx_telegram_wrapups_platform_content ON telegram_wrapups(platform_source, content_session_id);
CREATE TABLE sync_pull_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch TEXT NOT NULL,
        seq TEXT NOT NULL,
        kind TEXT,
        entity_id TEXT,
        origin_device_id TEXT,
        origin_local_id TEXT,
        entity_rev TEXT,
        operation_sha256 TEXT,
        reason TEXT NOT NULL,
        raw_body TEXT NOT NULL,
        retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(epoch, seq)
      );
CREATE INDEX idx_observations_title_norm ON observations(project, title_norm_key);
CREATE TABLE token_df (
        project TEXT    NOT NULL,
        token   TEXT    NOT NULL,
        df      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project, token)
      );
CREATE TABLE dedup_meta (
        project                TEXT    PRIMARY KEY,
        doc_count              INTEGER NOT NULL DEFAULT 0,
        last_rebuild_doc_count INTEGER NOT NULL DEFAULT 0,
        deleted_since_rebuild  INTEGER NOT NULL DEFAULT 0
      );
CREATE TABLE observation_dedup_candidates (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id   INTEGER NOT NULL,
        duplicate_of_id  INTEGER NOT NULL,
        project          TEXT    NOT NULL,
        method           TEXT    NOT NULL CHECK(method IN ('exact', 'idf_cosine')),
        score            REAL    NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'pending'
                                 CHECK(status IN ('pending', 'merged', 'distinct', 'dismissed')),
        created_at       TEXT    NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        metadata         TEXT,
        FOREIGN KEY (observation_id)  REFERENCES observations(id) ON DELETE CASCADE,
        FOREIGN KEY (duplicate_of_id) REFERENCES observations(id) ON DELETE CASCADE,
        UNIQUE(observation_id, duplicate_of_id)
      );
CREATE INDEX idx_token_df_project ON token_df(project);
CREATE INDEX idx_dedup_candidates_project ON observation_dedup_candidates(project, status);
CREATE INDEX idx_dedup_candidates_obs ON observation_dedup_candidates(observation_id);
CREATE INDEX idx_sdk_sessions_cwd ON sdk_sessions(cwd);
CREATE TRIGGER observations_au
  AFTER UPDATE OF title, subtitle, narrative, text, facts, concepts ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
    INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
  END;
CREATE TRIGGER session_summaries_au
  AFTER UPDATE OF request, investigated, learned, completed, next_steps, notes ON session_summaries BEGIN
    INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
    INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
  END;
CREATE INDEX idx_observations_project_nocase ON observations(project COLLATE NOCASE);
CREATE INDEX idx_observations_merged_into_nocase ON observations(merged_into_project COLLATE NOCASE);
CREATE INDEX idx_summaries_project_nocase ON session_summaries(project COLLATE NOCASE);
CREATE INDEX idx_summaries_merged_into_nocase ON session_summaries(merged_into_project COLLATE NOCASE);
CREATE INDEX idx_sdk_sessions_project_nocase ON sdk_sessions(project COLLATE NOCASE);
CREATE TABLE advisor_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        advisor_model TEXT,
        cwd TEXT,
        last_user_message TEXT,
        transcript_path TEXT,
        transcript_byte_offset INTEGER,
        advice TEXT NOT NULL,
        occurred_at_epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      );
CREATE UNIQUE INDEX idx_advisor_calls_tool_use ON advisor_calls(tool_use_id);
CREATE INDEX idx_advisor_calls_session ON advisor_calls(session_db_id);
CREATE INDEX idx_advisor_calls_project ON advisor_calls(project);
CREATE INDEX idx_advisor_calls_occurred ON advisor_calls(occurred_at_epoch DESC);
CREATE TABLE work_state_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      list_name TEXT NOT NULL,
      fields TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
CREATE INDEX idx_work_state_entries_project ON work_state_entries(project COLLATE NOCASE, list_name, id);
