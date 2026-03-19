import { Request, Response, NextFunction } from 'express';
import { requireRole } from '../rbac';
import { UserRole } from '../../types';

function makeReq(role?: UserRole): Partial<Request> {
  return role
    ? { user: { cognitoSub: 'sub-123', email: 'a@b.com', role, mfaEnabled: true } }
    : {};
}

function makeRes(): { status: jest.Mock; json: jest.Mock } & Partial<Response> {
  const json   = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json } as any;
}

const next: NextFunction = jest.fn();

beforeEach(() => jest.clearAllMocks());

describe('requireRole', () => {
  describe('unauthenticated request (no req.user)', () => {
    it('returns 401', () => {
      const req = makeReq();           // no user
      const res = makeRes();
      requireRole(UserRole.Administrator)(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('wrong role', () => {
    it('returns 403 when reviewer tries admin-only route', () => {
      const req = makeReq(UserRole.Reviewer);
      const res = makeRes();
      requireRole(UserRole.Administrator)(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 when auditor tries write route', () => {
      const req = makeReq(UserRole.Auditor);
      const res = makeRes();
      requireRole(UserRole.Administrator, UserRole.Reviewer)(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('correct role', () => {
    it('calls next() when role matches exactly', () => {
      const req = makeReq(UserRole.Administrator);
      const res = makeRes();
      requireRole(UserRole.Administrator)(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next() when role is one of several allowed roles', () => {
      const req = makeReq(UserRole.Reviewer);
      const res = makeRes();
      requireRole(UserRole.Administrator, UserRole.Reviewer)(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });

    it('allows adjudicator on adjudicator+admin route', () => {
      const req = makeReq(UserRole.Adjudicator);
      const res = makeRes();
      requireRole(UserRole.Administrator, UserRole.Adjudicator)(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });

    it('allows auditor on read-all-roles route', () => {
      const req = makeReq(UserRole.Auditor);
      const res = makeRes();
      requireRole(
        UserRole.Administrator,
        UserRole.Reviewer,
        UserRole.Adjudicator,
        UserRole.Auditor,
      )(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('response payload', () => {
    it('includes required and actual role in 403 body', () => {
      const req = makeReq(UserRole.Auditor);
      const res = makeRes();
      requireRole(UserRole.Administrator)(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.json.mock.calls[0][0];
      expect(body).toMatchObject({
        error:    'Forbidden',
        required: [UserRole.Administrator],
        actual:   UserRole.Auditor,
      });
    });
  });
});
