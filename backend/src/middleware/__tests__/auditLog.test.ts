import { Pool } from 'pg';
import { AuditLogWriter, AuditAction } from '../auditLog';

function makePool(queryFn = jest.fn().mockResolvedValue({})) {
  return { query: queryFn } as unknown as Pool;
}

describe('AuditLogWriter', () => {
  describe('write()', () => {
    it('inserts a row with all provided fields', async () => {
      const query = jest.fn().mockResolvedValue({});
      const writer = new AuditLogWriter(makePool(query));

      await writer.write({
        userId:     'user-abc',
        action:     AuditAction.PROJECT_CREATED,
        entityType: 'project',
        entityId:   'proj-123',
        projectId:  'proj-123',
        payload:    { name: 'Test Project' },
      });

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO audit_log/i);
      expect(params[0]).toBe('user-abc');           // user_id
      expect(params[1]).toBeNull();                  // system_flag
      expect(params[2]).toBe(AuditAction.PROJECT_CREATED);
      expect(params[3]).toBe('project');
      expect(params[4]).toBe('proj-123');
      expect(params[5]).toBe('proj-123');
      expect(params[6]).toContain('Test Project');   // JSON payload
    });

    it('passes null for optional fields when omitted', async () => {
      const query = jest.fn().mockResolvedValue({});
      const writer = new AuditLogWriter(makePool(query));

      await writer.write({
        action:     AuditAction.EXPORT_GENERATED,
        entityType: 'export',
      });

      const [, params] = query.mock.calls[0];
      expect(params[0]).toBeNull();   // user_id
      expect(params[1]).toBeNull();   // system_flag
      expect(params[4]).toBeNull();   // entity_id
      expect(params[5]).toBeNull();   // project_id
      expect(params[6]).toBeNull();   // payload
    });

    it('uses systemFlag when no userId is provided', async () => {
      const query = jest.fn().mockResolvedValue({});
      const writer = new AuditLogWriter(makePool(query));

      await writer.write({
        systemFlag:  'AUTO_MATCH',
        action:      AuditAction.TERM_AUTO_MATCHED,
        entityType:  'project_term',
        entityId:    'term-xyz',
        projectId:   'proj-456',
      });

      const [, params] = query.mock.calls[0];
      expect(params[0]).toBeNull();         // user_id
      expect(params[1]).toBe('AUTO_MATCH'); // system_flag
    });

    it('propagates database errors', async () => {
      const query = jest.fn().mockRejectedValue(new Error('DB connection lost'));
      const writer = new AuditLogWriter(makePool(query));

      await expect(
        writer.write({ action: AuditAction.MAPPING_SUBMITTED, entityType: 'mapping_decision' }),
      ).rejects.toThrow('DB connection lost');
    });
  });

  describe('AuditAction constants', () => {
    it('has no duplicate values', () => {
      const values = Object.values(AuditAction);
      const unique  = new Set(values);
      expect(unique.size).toBe(values.length);
    });

    it('covers all expected lifecycle events', () => {
      expect(AuditAction.PROJECT_CREATED).toBeDefined();
      expect(AuditAction.TERM_AUTO_MATCHED).toBeDefined();
      expect(AuditAction.MAPPING_SUBMITTED).toBeDefined();
      expect(AuditAction.ADJUDICATION_RESOLVED).toBeDefined();
      expect(AuditAction.MAPPING_CANONICALISED).toBeDefined();
      expect(AuditAction.MAPPING_SUPERSEDED).toBeDefined();
      expect(AuditAction.EXPORT_GENERATED).toBeDefined();
      expect(AuditAction.HOLDOUT_LOCKED).toBeDefined();
      expect(AuditAction.CERTIFICATION_GRANTED).toBeDefined();
    });
  });
});
