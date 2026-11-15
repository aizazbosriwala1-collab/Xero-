import { db } from '../db/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('SupportService');

export interface SupportMessageRecord {
  id: string;
  senderType: 'CUSTOMER' | 'ADMIN';
  senderId: string;
  message: string;
  attachmentFileId?: string | null;
  createdAt: string;
}

export interface SupportTicket {
  id: string;
  ticketNumber: number;
  userId: string;
  username?: string | null;
  firstName?: string | null;
  orderId?: string | null;
  issueType: string;
  subject: string;
  status: 'OPEN' | 'WAITING' | 'RESOLVED' | 'CLOSED';
  createdAt: string;
  updatedAt?: string;
  closedBy?: string | null;
  closedAt?: string | null;
  messages: SupportMessageRecord[];
}

export class SupportService {
  /**
   * Create a new support ticket with human-friendly sequential #ticketNumber (e.g. #101, #102)
   */
  public async createTicket(params: {
    userId: string;
    orderId?: string;
    issueType: string;
    subject: string;
    message: string;
    attachmentFileId?: string;
  }): Promise<string> {
    const detailed = await this.createTicketDetailed(params);
    return detailed.id;
  }

  public async createTicketDetailed(params: {
    userId: string;
    orderId?: string;
    issueType: string;
    subject: string;
    message: string;
    attachmentFileId?: string;
  }): Promise<{ id: string; ticketNumber: number; status: 'OPEN' }> {
    const ticketId = `tkt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    let ticketNumber = 101;

    await db.withTransaction(async (client) => {
      const maxRow = await client.queryRow<{ maxNum: number | string | null }>(
        'SELECT COALESCE(MAX(ticket_number), 100) as "maxNum" FROM support_tickets'
      );
      ticketNumber = Number(maxRow?.maxNum || 100) + 1;

      await client.query(
        `INSERT INTO support_tickets (
          id, ticket_number, user_id, order_id, issue_type, subject, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [ticketId, ticketNumber, params.userId, params.orderId || null, params.issueType, params.subject]
      );

      await client.query(
        `INSERT INTO support_messages (id, ticket_id, sender_type, sender_id, message, attachment_file_id, created_at)
         VALUES ($1, $2, 'CUSTOMER', $3, $4, $5, CURRENT_TIMESTAMP)`,
        [msgId, ticketId, params.userId, params.message, params.attachmentFileId || null]
      );
    });

    logger.info('Support ticket created', {
      ticketId,
      ticketNumber,
      userId: params.userId,
      issueType: params.issueType,
    });
    return { id: ticketId, ticketNumber, status: 'OPEN' };
  }

  /**
   * Add a message (admin reply or customer follow-up) to an existing ticket, retaining full history
   */
  public async addMessage(params: {
    ticketId: string;
    senderType: 'CUSTOMER' | 'ADMIN';
    senderId: string;
    message: string;
    attachmentFileId?: string;
  }): Promise<{ ticketNumber: number; userId: string; status: SupportTicket['status'] }> {
    const cleanMsg = String(params.message || '').trim();
    if (!cleanMsg && !params.attachmentFileId) {
      throw new Error('Reply message cannot be empty.');
    }

    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newStatus: SupportTicket['status'] = params.senderType === 'ADMIN' ? 'WAITING' : 'OPEN';
    let userId = '';
    let ticketNumber = 0;

    await db.withTransaction(async (client) => {
      const tkt = await client.queryRow<any>(
        'SELECT id, user_id, ticket_number, status FROM support_tickets WHERE id = $1 FOR UPDATE',
        [params.ticketId]
      );
      if (!tkt) {
        throw new Error(`Ticket ${params.ticketId} not found.`);
      }
      if (tkt.status === 'CLOSED' && params.senderType === 'ADMIN') {
        throw new Error('This ticket is already closed.');
      }

      userId = String(tkt.user_id);
      ticketNumber = Number(tkt.ticket_number || 0) || 100;

      await client.query(
        `INSERT INTO support_messages (id, ticket_id, sender_type, sender_id, message, attachment_file_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
        [msgId, params.ticketId, params.senderType, params.senderId, cleanMsg || '[Screenshot Attached]', params.attachmentFileId || null]
      );

      await client.query(
        `UPDATE support_tickets
         SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [newStatus, params.ticketId]
      );
    });

    logger.info('Support ticket message added', {
      ticketId: params.ticketId,
      ticketNumber,
      senderType: params.senderType,
      newStatus,
    });

    return { ticketNumber, userId, status: newStatus };
  }

  /**
   * Close a support ticket cleanly with admin audit trail
   */
  public async closeTicket(
    ticketId: string,
    adminId: string
  ): Promise<{ id: string; ticketNumber: number; userId: string; status: 'CLOSED' }> {
    return await db.withTransaction(async (client) => {
      const tkt = await client.queryRow<any>(
        'SELECT id, user_id, ticket_number, status FROM support_tickets WHERE id = $1 FOR UPDATE',
        [ticketId]
      );
      if (!tkt) {
        throw new Error(`Ticket ${ticketId} not found.`);
      }

      await client.query(
        `UPDATE support_tickets
         SET status = 'CLOSED', closed_by = $1, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [adminId, ticketId]
      );

      await client.query(
        `INSERT INTO admin_audit_logs (id, admin_id, action, target_entity, target_id, details)
         VALUES ($1, $2, 'CLOSE_SUPPORT_TICKET', 'support_tickets', $3, $4)`,
        [
          `aud_tkt_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
          adminId,
          ticketId,
          JSON.stringify({ ticketNumber: tkt.ticket_number || null, previousStatus: tkt.status }),
        ]
      );

      return {
        id: ticketId,
        ticketNumber: Number(tkt.ticket_number || 0),
        userId: String(tkt.user_id),
        status: 'CLOSED' as const,
      };
    });
  }

  /**
   * Get single ticket by ID (or #number) with full retained message history and customer username
   */
  public async getTicketById(ticketIdOrNumber: string): Promise<SupportTicket | null> {
    const clean = String(ticketIdOrNumber || '').replace(/^#/, '').trim();
    const isNum = /^\d+$/.test(clean);

    const tkt = await db.queryRow<any>(
      `SELECT st.id, st.ticket_number as "ticketNumber", st.user_id as "userId",
              u.username, u.first_name as "firstName",
              st.order_id as "orderId", st.issue_type as "issueType",
              st.subject, st.status, st.created_at as "createdAt",
              st.updated_at as "updatedAt", st.closed_by as "closedBy", st.closed_at as "closedAt"
       FROM support_tickets st
       LEFT JOIN users u ON st.user_id = u.id
       WHERE ${isNum ? 'st.ticket_number = $1' : 'st.id = $1'}`,
      [isNum ? Number(clean) : clean]
    );
    if (!tkt) return null;

    const msgsRes = await db.query<any>(
      `SELECT id, sender_type as "senderType", sender_id as "senderId",
              message, attachment_file_id as "attachmentFileId", created_at as "createdAt"
       FROM support_messages
       WHERE ticket_id = $1
       ORDER BY created_at ASC`,
      [tkt.id]
    );

    return {
      id: tkt.id,
      ticketNumber: Number(tkt.ticketNumber || 0),
      userId: tkt.userId,
      username: tkt.username || null,
      firstName: tkt.firstName || null,
      orderId: tkt.orderId || null,
      issueType: tkt.issueType,
      subject: tkt.subject,
      status: tkt.status,
      createdAt: tkt.createdAt,
      updatedAt: tkt.updatedAt,
      closedBy: tkt.closedBy || null,
      closedAt: tkt.closedAt || null,
      messages: msgsRes.rows,
    };
  }

  /**
   * List tickets for Admin Inbox (open/waiting prioritized, joined with user identity)
   */
  public async listAdminTickets(options?: {
    statusFilter?: 'OPEN_ONLY' | 'ALL';
    limit?: number;
  }): Promise<SupportTicket[]> {
    const limit = Math.min(30, Math.max(1, options?.limit ?? 15));
    const whereClause =
      options?.statusFilter === 'OPEN_ONLY' ? "WHERE st.status IN ('OPEN', 'WAITING')" : '';

    const ticketsRes = await db.query<any>(
      `SELECT st.id, st.ticket_number as "ticketNumber", st.user_id as "userId",
              u.username, u.first_name as "firstName",
              st.order_id as "orderId", st.issue_type as "issueType",
              st.subject, st.status, st.created_at as "createdAt",
              st.updated_at as "updatedAt", st.closed_by as "closedBy", st.closed_at as "closedAt"
       FROM support_tickets st
       LEFT JOIN users u ON st.user_id = u.id
       ${whereClause}
       ORDER BY CASE WHEN st.status IN ('OPEN', 'WAITING') THEN 0 ELSE 1 END ASC,
                st.updated_at DESC
       LIMIT $1`,
      [limit]
    );

    return ticketsRes.rows.map(t => ({
      id: t.id,
      ticketNumber: Number(t.ticketNumber || 0),
      userId: t.userId,
      username: t.username || null,
      firstName: t.firstName || null,
      orderId: t.orderId || null,
      issueType: t.issueType,
      subject: t.subject,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      closedBy: t.closedBy || null,
      closedAt: t.closedAt || null,
      messages: [],
    }));
  }

  /**
   * Get customer tickets with full message history
   */
  public async getUserTickets(userId: string): Promise<SupportTicket[]> {
    const ticketsRes = await db.query<any>(
      `SELECT id, ticket_number as "ticketNumber", user_id as "userId", order_id as "orderId",
              issue_type as "issueType", subject, status, created_at as "createdAt",
              updated_at as "updatedAt", closed_by as "closedBy", closed_at as "closedAt"
       FROM support_tickets
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 10`,
      [userId]
    );

    const tickets: SupportTicket[] = [];
    for (const t of ticketsRes.rows) {
      const msgsRes = await db.query<any>(
        `SELECT id, sender_type as "senderType", sender_id as "senderId",
                message, attachment_file_id as "attachmentFileId", created_at as "createdAt"
         FROM support_messages
         WHERE ticket_id = $1
         ORDER BY created_at ASC`,
        [t.id]
      );

      tickets.push({
        id: t.id,
        ticketNumber: Number(t.ticketNumber || 0),
        userId: t.userId,
        orderId: t.orderId || null,
        issueType: t.issueType,
        subject: t.subject,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        closedBy: t.closedBy || null,
        closedAt: t.closedAt || null,
        messages: msgsRes.rows,
      });
    }

    return tickets;
  }
}

export const supportService = new SupportService();
