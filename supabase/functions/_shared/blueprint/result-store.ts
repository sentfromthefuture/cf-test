// Server-side persistence for completed, backend-validated ProductBlueprintV1 results.
// This adapter is deliberately independent of browser clients and uses only the service-role key.
import type { ProductBlueprintV1 } from './contract.ts';
import { validateProductBlueprint } from './validate.ts';

export interface BlueprintResultIdentity {
  userId: string;
  clusterId: string;
  requestKeyHash: string;
  requestParams: Record<string, string>;
  model: string;
  configVersion: string;
}

export interface BlueprintResultStoreConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}

export interface StoredBlueprintResult {
  id: string;
  created_at: string;
  blueprint: ProductBlueprintV1;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export class BlueprintResultStore {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly config: BlueprintResultStoreConfig) {
    if (!/^https:\/\//.test(config.supabaseUrl) || !config.serviceRoleKey) {
      throw new TypeError('invalid_blueprint_result_store_config');
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.baseUrl = config.supabaseUrl.replace(/\/$/, '') + '/rest/v1/dr_blueprints';
  }

  private assertIdentity(identity: BlueprintResultIdentity): void {
    if (!UUID.test(identity.userId) || !UUID.test(identity.clusterId)
      || !SHA256.test(identity.requestKeyHash)
      || !identity.model.endsWith(':free')
      || !identity.configVersion) {
      throw new TypeError('invalid_blueprint_result_identity');
    }
  }

  /** Returns the exact prior result for a retry; never searches by client-controlled data alone. */
  async get(identity: BlueprintResultIdentity): Promise<StoredBlueprintResult | null> {
    this.assertIdentity(identity);
    const query = new URLSearchParams({
      select: 'id,created_at,blueprint',
      user_id: 'eq.' + identity.userId,
      cluster_id: 'eq.' + identity.clusterId,
      request_key_hash: 'eq.' + identity.requestKeyHash,
      limit: '2',
    });
    const response = await this.fetchImpl(this.baseUrl + '?' + query.toString(), {
      method: 'GET',
      headers: {
        apikey: this.config.serviceRoleKey,
        authorization: 'Bearer ' + this.config.serviceRoleKey,
        accept: 'application/json',
      },
    });
    if (!response.ok) throw new Error('blueprint_result_read_failed:' + response.status);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error('blueprint_result_read_invalid_response');
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error('blueprint_result_identity_ambiguous');
    const row = rows[0];
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error('blueprint_result_read_invalid_response');
    }
    const value = row as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.created_at !== 'string') {
      throw new Error('blueprint_result_read_invalid_response');
    }
    const validated = validateProductBlueprint(value.blueprint);
    if (!validated.ok) throw new Error('blueprint_result_failed_validation');
    return { id: value.id, created_at: value.created_at, blueprint: validated.value };
  }

  async save(identity: BlueprintResultIdentity, blueprint: ProductBlueprintV1): Promise<{ id: string; created_at: string }> {
    this.assertIdentity(identity);
    if (blueprint.meta.contract_version !== 'product-blueprint.v1'
      || !SHA256.test(blueprint.meta.evidence_pack.pack_sha256)) {
      throw new TypeError('invalid_blueprint_result');
    }

    const query = new URLSearchParams({ on_conflict: 'user_id,cluster_id,request_key_hash' });
    const response = await this.fetchImpl(this.baseUrl + '?' + query.toString(), {
      method: 'POST',
      headers: {
        apikey: this.config.serviceRoleKey,
        authorization: 'Bearer ' + this.config.serviceRoleKey,
        'content-type': 'application/json',
        accept: 'application/vnd.pgrst.object+json',
        prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({
        user_id: identity.userId,
        cluster_id: identity.clusterId,
        request_key_hash: identity.requestKeyHash,
        request_params: identity.requestParams,
        schema_version: blueprint.meta.contract_version,
        model: identity.model,
        config_version: identity.configVersion,
        evidence_pack_sha256: blueprint.meta.evidence_pack.pack_sha256,
        blueprint,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!response.ok) {
      // Do not include response bodies: PostgREST errors can contain submitted data.
      throw new Error('blueprint_result_persistence_failed:' + response.status);
    }
    const row: unknown = await response.json();
    if (typeof row !== 'object' || row === null || Array.isArray(row)
      || typeof (row as Record<string, unknown>).id !== 'string'
      || typeof (row as Record<string, unknown>).created_at !== 'string') {
      throw new Error('blueprint_result_persistence_invalid_response');
    }
    return { id: (row as Record<string, string>).id, created_at: (row as Record<string, string>).created_at };
  }
}
