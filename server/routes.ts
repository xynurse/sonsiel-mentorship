import type { Express, Request as ExpressRequest } from "express";
import { createServer, type Server } from "http";
import rateLimit from "express-rate-limit";
import { setupAuth, requireAuth, requireRole, getSessionMiddleware } from "./auth";
import { storage } from "./storage";
import { insertCohortSchema, insertApplicationQuestionSchema, insertCohortMembershipSchema, insertMentorshipMatchSchema, insertMessageSchema, insertConversationSchema, insertDocumentSchema, insertFolderSchema, insertDocumentAccessSchema, insertGoalSchema, insertMilestoneSchema, insertGoalProgressSchema, insertNotificationSchema, insertNotificationPreferenceSchema, insertCertificateSchema, insertMeetingLogSchema, insertCommunityThreadSchema, insertThreadReplySchema, insertThreadCategorySchema, insertJournalEntrySchema, insertReminderSchema, programApplications as programApplicationsTable, programApplicationStatusEnum, cocAcceptances as cocAcceptancesTable } from "@shared/schema";
import { z } from "zod";
import {
  setupWebSocket,
  getOnlineUsers,
  isUserOnline,
  emitNotification,
  emitNotificationCountUpdate,
  emitMessageNew,
  emitMessageDeleted,
  emitMessagesRead,
  issueClientToken,
} from "./realtime/ably";
import {
  streamRequestToBlob,
  streamBlobToResponse,
  ObjectNotFoundError,
  UploadValidationError,
  isBlobUrl,
  type UploadKind,
} from "./storage/blob";
import { AuditService, createAuditMiddleware } from "./audit";
import { runMatchNudges } from "./jobs/match-nudges";
import { sessionFeedbackInputSchema } from "@shared/session-feedback";
import ical, { ICalEventStatus } from "ical-generator";
import { randomUUID } from "crypto";
import { db } from "./db";
import { users as usersTable, cohortMemberships as cohortMembershipsTable, messages as messagesTable } from "@shared/schema";
import { eq, inArray, and } from "drizzle-orm";

const generalApiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/notifications') || req.path.startsWith('/api/messages'),
});

const uploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { message: "Upload limit reached, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use('/api/', generalApiLimiter);

  setupAuth(app);
  
  // Set up WebSocket server after auth is initialized
  const sessionMiddleware = getSessionMiddleware();
  if (sessionMiddleware) {
    setupWebSocket(httpServer, sessionMiddleware);
  }

  app.get("/api/admin/stats", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const stats = await storage.getAdminDashboardStats();
      res.json(stats);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/email-diagnostics", requireRole("SUPER_ADMIN", "ADMIN"), async (_req, res) => {
    const hasApiKey = !!process.env.RESEND_API_KEY;
    res.json({
      timestamp: new Date().toISOString(),
      environment: {
        nodeEnv: process.env.NODE_ENV,
        runningOn: process.env.VERCEL ? "vercel" : "local",
      },
      resendConnection: {
        status: hasApiKey ? "configured" : "error",
        error: hasApiKey ? null : "RESEND_API_KEY is not set",
        fromEmail:
          process.env.RESEND_FROM_EMAIL ||
          "SONSIEL Mentorship Hub <noreply@sonsiel.org>",
      },
    });
  });

  app.get("/api/users", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { role, search, isActive } = req.query;
      const users = await storage.getAllUsers({
        role: role as string | undefined,
        search: search as string | undefined,
        isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
      });
      const safeUsers = users.map(({ password, ...user }) => user);
      res.json(safeUsers);
    } catch (error) {
      next(error);
    }
  });

  // Get all users that can be messaged (for starting new conversations)
  app.get("/api/users/messageable", requireAuth, async (req, res, next) => {
    try {
      const currentUser = req.user as any;
      const users = await storage.getAllUsers({ isActive: true });
      const safeUsers = users
        .filter(u => u.id !== currentUser.id)
        .map(({ password, ...user }) => ({
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          profileImage: user.profileImage,
        }));
      res.json(safeUsers);
    } catch (error) {
      next(error);
    }
  });

  // CSV Export endpoints
  app.get("/api/export/users", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { role, isActive } = req.query;
      const users = await storage.getAllUsers({
        role: role as string | undefined,
        isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
      });
      
      const headers = ["ID", "Email", "First Name", "Last Name", "Role", "Status", "Created At"];
      const rows = users.map(u => [
        u.id,
        u.email,
        u.firstName,
        u.lastName,
        u.role,
        u.isActive ? "Active" : "Inactive",
        u.createdAt ? new Date(u.createdAt).toISOString() : ""
      ]);
      
      const sanitizeCell = (val: unknown) => {
        const str = String(val || '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ');
        return `"${str}"`;
      };
      const csv = [headers, ...rows].map(row => 
        row.map(sanitizeCell).join(",")
      ).join("\r\n");
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=users_export_${Date.now()}.csv`);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.send(csv);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/export/certificates", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const filters: { userId?: string; cohortId?: string; status?: string } = {};
      if (req.query.userId) filters.userId = req.query.userId as string;
      if (req.query.cohortId) filters.cohortId = req.query.cohortId as string;
      if (req.query.status) filters.status = req.query.status as string;
      
      const certs = await storage.getCertificates(filters);
      
      const headers = ["Certificate Number", "User ID", "Cohort ID", "Status", "Issued At", "Expires At", "Created At"];
      const rows = certs.map(c => [
        c.certificateNumber,
        c.userId,
        c.cohortId || "",
        c.status,
        c.issuedAt ? new Date(c.issuedAt).toISOString() : "",
        c.expiresAt ? new Date(c.expiresAt).toISOString() : "",
        c.createdAt ? new Date(c.createdAt).toISOString() : ""
      ]);
      
      const sanitizeCell = (val: unknown) => {
        const str = String(val || '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ');
        return `"${str}"`;
      };
      const csv = [headers, ...rows].map(row => 
        row.map(sanitizeCell).join(",")
      ).join("\r\n");
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=certificates_export_${Date.now()}.csv`);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.send(csv);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/users/:id/force-logout", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      res.json({ message: "Force logout coming soon" });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/users/:id/deactivate", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const targetUser = await storage.getUser(id);
      const updatedUser = await storage.updateUser(id, { isActive: false });
      
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'USER_DEACTIVATED',
        resourceType: 'USER',
        resourceId: id,
        resourceName: targetUser?.email || updatedUser.email,
        metadata: { deactivatedBy: req.user!.email },
      });

      res.json({ message: "User deactivated successfully" });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/users/:id/activate", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const targetUser = await storage.getUser(id);
      const updatedUser = await storage.updateUser(id, { isActive: true });
      
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'USER_ACTIVATED',
        resourceType: 'USER',
        resourceId: id,
        resourceName: targetUser?.email || updatedUser.email,
        metadata: { activatedBy: req.user!.email },
      });

      res.json({ message: "User activated successfully" });
    } catch (error) {
      next(error);
    }
  });

  // Delete user endpoint (permanent delete)
  app.delete("/api/admin/users/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const currentUser = req.user as any;
      
      // Prevent self-deletion
      if (id === currentUser.id) {
        return res.status(400).json({ message: "Cannot delete your own account" });
      }
      
      const userToDelete = await storage.getUser(id);
      if (!userToDelete) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Only SUPER_ADMIN can delete ADMIN or SUPER_ADMIN users
      if ((userToDelete.role === "SUPER_ADMIN" || userToDelete.role === "ADMIN") && currentUser.role !== "SUPER_ADMIN") {
        return res.status(403).json({ message: "Only Super Admins can delete admin accounts" });
      }
      
      await storage.deleteUser(id);
      
      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'USER_DELETED',
        resourceType: 'USER',
        resourceId: id,
        resourceName: userToDelete.email,
        metadata: { deletedBy: req.user!.email, deletedUserRole: userToDelete.role },
      });
      
      res.json({ message: "User deleted successfully" });
    } catch (error) {
      next(error);
    }
  });

  // Admin get user profile with mentee/mentor extended info
  // GET CoC acceptance record for a specific user (admin only)
  app.get("/api/admin/users/:id/coc", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const [acceptance] = await db
        .select()
        .from(cocAcceptancesTable)
        .where(eq(cocAcceptancesTable.userId, id))
        .limit(1);
      res.json(acceptance ?? null);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/users/:id/profile", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get mentee profile if exists
      const menteeProfile = await storage.getMenteeProfile(id);
      
      // Get mentor profile extended if exists
      const mentorProfileExtended = await storage.getMentorProfileExtended(id);
      
      // Determine mentorship role based on profiles
      let mentorshipRole: string | null = null;
      if (menteeProfile && mentorProfileExtended) {
        mentorshipRole = "both";
      } else if (menteeProfile) {
        mentorshipRole = "seeking_mentor";
      } else if (mentorProfileExtended) {
        mentorshipRole = "providing_mentorship";
      }

      res.json({
        user,
        menteeProfile,
        mentorProfileExtended,
        mentorshipRole,
      });
    } catch (error) {
      next(error);
    }
  });

  // Admin update user profile with mentee/mentor extended info
  app.put("/api/admin/users/:id/profile", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { userUpdates, mentorshipRole, menteeProfile, mentorProfileExtended } = req.body;
      
      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Whitelist allowed user fields for updates
      const allowedUserFields = [
        "firstName", "lastName", "role", "jobTitle", "organizationName",
        "isSonsielMember", "interestedInMembership", "preferredLanguage",
        "fieldsOfExpertise", "educationLevel", "yearsOfExperience",
        "yearsInSielAreas", "certificationsTraining"
      ];
      
      // Helper to convert empty strings to null for enum/optional fields
      const sanitizeData = (data: any, allowedFields?: string[]) => {
        if (!data) return data;
        const sanitized: any = {};
        for (const [key, value] of Object.entries(data)) {
          if (allowedFields && !allowedFields.includes(key)) continue;
          sanitized[key] = value === "" ? null : value;
        }
        return sanitized;
      };

      // Update user core fields with whitelist
      if (userUpdates) {
        const sanitizedUserUpdates = sanitizeData(userUpdates, allowedUserFields);
        if (Object.keys(sanitizedUserUpdates).length > 0) {
          await storage.updateUser(id, sanitizedUserUpdates);
        }
      }

      // Handle mentee profile based on role choice
      if (mentorshipRole === "seeking_mentor" || mentorshipRole === "both") {
        const sanitizedMenteeProfile = sanitizeData(menteeProfile || {});
        const existingMenteeProfile = await storage.getMenteeProfile(id);
        if (existingMenteeProfile) {
          await storage.updateMenteeProfile(id, sanitizedMenteeProfile);
        } else if (Object.keys(sanitizedMenteeProfile).length > 0 || mentorshipRole) {
          await storage.createMenteeProfile({ ...sanitizedMenteeProfile, userId: id });
        }
      } else if (mentorshipRole === "providing_mentorship") {
        // If switching to mentor-only, optionally archive/clean mentee profile
        // For now, we keep the profile data but it won't affect role inference
      }

      // Handle mentor profile extended based on role choice
      if (mentorshipRole === "providing_mentorship" || mentorshipRole === "both") {
        const sanitizedMentorProfile = sanitizeData(mentorProfileExtended || {});
        const existingMentorProfile = await storage.getMentorProfileExtended(id);
        if (existingMentorProfile) {
          await storage.updateMentorProfileExtended(id, sanitizedMentorProfile);
        } else if (Object.keys(sanitizedMentorProfile).length > 0 || mentorshipRole) {
          await storage.createMentorProfileExtended({ ...sanitizedMentorProfile, userId: id });
        }
      } else if (mentorshipRole === "seeking_mentor") {
        // If switching to mentee-only, optionally archive/clean mentor profile
        // For now, we keep the profile data but it won't affect role inference
      }

      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'USER_UPDATED',
        resourceType: 'USER',
        resourceId: id,
        resourceName: user.email,
        metadata: { updatedBy: req.user!.email, mentorshipRole, sectionsUpdated: Object.keys(req.body).filter(k => req.body[k]) },
      });

      res.json({ message: "Profile updated successfully" });
    } catch (error) {
      next(error);
    }
  });

  // Admin create user endpoint
  app.post("/api/admin/users", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { email, password, firstName, lastName, role, organizationName, jobTitle } = req.body;
      
      // Validate required fields
      if (!email || !password || !firstName || !lastName || !role) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Validate role is in allowed enum values
      const validRoles = ["SUPER_ADMIN", "ADMIN", "MENTOR", "MENTEE"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ message: "Invalid role. Must be one of: " + validRoles.join(", ") });
      }

      // Only SUPER_ADMIN can create ADMIN or SUPER_ADMIN users
      const currentUser = req.user as any;
      if ((role === "SUPER_ADMIN" || role === "ADMIN") && currentUser.role !== "SUPER_ADMIN") {
        return res.status(403).json({ message: "Only Super Admins can create admin accounts" });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ message: "Invalid email format" });
      }

      // Validate password strength
      if (password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }

      // Check if email already exists (including soft-deleted users)
      const emailTaken = await storage.emailExists(email);
      if (emailTaken) {
        return res.status(400).json({ message: "A user with this email address already exists" });
      }

      // Import hashPassword from auth module
      const { hashPassword } = await import("./auth");
      const hashedPassword = await hashPassword(password);

      const user = await storage.createUser({
        email,
        password: hashedPassword,
        firstName,
        lastName,
        role,
        organizationName: organizationName || null,
        jobTitle: jobTitle || null,
        isActive: true,
        isVerified: false,
        isProfileComplete: false,
        mustChangePassword: true,
      });

      const { password: _, ...safeUser } = user;

      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'USER_CREATED',
        resourceType: 'USER',
        resourceId: user.id,
        resourceName: user.email,
        metadata: { role, firstName, lastName, createdBy: req.user!.email, registrationMethod: 'admin' },
      });

      try {
        const { sendWelcomeEmail, getTrustedBaseUrl } = await import("./email");
        const baseUrl = getTrustedBaseUrl();
        const emailResult = await sendWelcomeEmail({
          email,
          firstName,
          lastName,
          temporaryPassword: password,
          loginUrl: `${baseUrl}/login`,
        });
        if (emailResult.success) {
          await audit.log({
            action: 'EMAIL_SENT',
            resourceType: 'USER',
            resourceId: user.id,
            resourceName: user.email,
            metadata: { emailType: 'welcome', recipient: email },
          });
        } else {
          console.warn(`Welcome email failed for ${email}:`, emailResult.error);
          await audit.log({
            action: 'EMAIL_SENT',
            resourceType: 'USER',
            resourceId: user.id,
            resourceName: user.email,
            success: false,
            errorMessage: emailResult.error || 'Failed to send welcome email',
            metadata: { emailType: 'welcome', recipient: email },
          });
        }
      } catch (emailError) {
        console.warn(`Failed to send welcome email to ${email}:`, emailError);
      }

      res.status(201).json({ ...safeUser, tempPassword: password });
    } catch (error: any) {
      // Handle duplicate email constraint error
      if (error?.message?.includes('duplicate key') && error?.message?.includes('email')) {
        return res.status(400).json({ message: "A user with this email address already exists" });
      }
      next(error);
    }
  });

  app.patch("/api/admin/users/:id/role", requireRole("SUPER_ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { role } = req.body;
      
      if (!role || !["SUPER_ADMIN", "ADMIN", "MENTOR", "MENTEE"].includes(role)) {
        return res.status(400).json({ message: "Invalid role" });
      }

      const previousUser = await storage.getUser(id);
      const updatedUser = await storage.updateUser(id, { role });
      
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'USER_ROLE_CHANGED',
        resourceType: 'USER',
        resourceId: id,
        resourceName: updatedUser.email,
        previousState: { role: previousUser?.role },
        newState: { role },
        metadata: { changedBy: req.user!.email, previousRole: previousUser?.role, newRole: role },
      });

      const { password: _, ...safeUser } = updatedUser;
      res.json(safeUser);
    } catch (error) {
      next(error);
    }
  });

  // Admin bulk import users from CSV
  app.post("/api/admin/users/bulk-import", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { users: usersData, defaultPassword } = req.body;
      
      if (!Array.isArray(usersData) || usersData.length === 0) {
        return res.status(400).json({ message: "No users data provided" });
      }

      const { hashPassword } = await import("./auth");
      const results = {
        successful: [] as any[],
        failed: [] as Array<{ row: number; email: string; error: string }>,
      };

      for (let i = 0; i < usersData.length; i++) {
        const userData = usersData[i];
        try {
          const { firstName, lastName, email, role, organizationName, jobTitle, phone, password: csvPassword } = userData;
          
          // Validate required fields
          if (!firstName || !lastName || !email || !role) {
            results.failed.push({
              row: i + 1,
              email: email || "unknown",
              error: "Missing required fields (firstName, lastName, email, role)"
            });
            continue;
          }

          // Validate role
          if (!["MENTOR", "MENTEE"].includes(role)) {
            results.failed.push({
              row: i + 1,
              email,
              error: "Invalid role. Must be MENTOR or MENTEE"
            });
            continue;
          }

          // Check if email exists
          const existingUser = await storage.getUserByEmail(email);
          if (existingUser) {
            results.failed.push({
              row: i + 1,
              email,
              error: "Email already registered"
            });
            continue;
          }

          // Use password from CSV, default password, or generate temporary password
          const tempPassword = csvPassword || defaultPassword || (Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8).toUpperCase());
          const hashedPassword = await hashPassword(tempPassword);

          const user = await storage.createUser({
            email,
            password: hashedPassword,
            firstName,
            lastName,
            role,
            organizationName: organizationName || null,
            jobTitle: jobTitle || null,
            phone: phone || null,
            isActive: true,
            isVerified: false,
            isProfileComplete: false,
            mustChangePassword: true,
          });

          const { password: _, ...safeUser } = user;
          results.successful.push({ ...safeUser, tempPassword, passwordSource: csvPassword ? 'csv' : (defaultPassword ? 'default' : 'generated') });
        } catch (error: any) {
          results.failed.push({
            row: i + 1,
            email: userData.email || "unknown",
            error: error.message || "Unknown error"
          });
        }
      }

      // Send welcome emails for successfully created users
      if (results.successful.length > 0) {
        try {
          const { sendBulkWelcomeEmails, getTrustedBaseUrl } = await import("./email");
          const baseUrl = getTrustedBaseUrl();
          const emailUsers = results.successful.map(u => ({
            email: u.email,
            firstName: u.firstName,
            lastName: u.lastName,
            temporaryPassword: u.tempPassword,
          }));
          const emailResults = await sendBulkWelcomeEmails(emailUsers, `${baseUrl}/login`);
          console.log(`Bulk import: sent ${emailResults.successful.length} welcome emails, ${emailResults.failed.length} failed`);
        } catch (emailError) {
          console.warn('Failed to send bulk welcome emails:', emailError);
        }
      }

      res.json({
        message: `Imported ${results.successful.length} users, ${results.failed.length} failed`,
        successful: results.successful,
        failed: results.failed,
      });
    } catch (error) {
      next(error);
    }
  });

  // Download CSV template for bulk import
  app.get("/api/admin/users/bulk-import/template", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res) => {
    const headers = "firstName,lastName,email,role";
    const examples = [
      "John,Doe,john.doe@example.com,MENTOR",
      "Jane,Smith,jane.smith@example.com,MENTEE",
      "Maria,Garcia,maria.garcia@example.com,MENTOR"
    ];
    const csv = [headers, ...examples].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=user-import-template.csv");
    res.send(csv);
  });

  // Bulk password reset - generates reset tokens for multiple users
  app.post("/api/admin/users/bulk-password-reset", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const bulkResetSchema = z.object({
        userIds: z.array(z.string().uuid()).min(1, "At least one user ID required"),
        setPassword: z.boolean().optional().default(false),
      });
      
      const parseResult = bulkResetSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: "Invalid request", errors: parseResult.error.flatten() });
      }
      
      const { userIds, setPassword } = parseResult.data;

      const { hashPassword } = await import("./auth");
      const results = {
        successful: [] as { userId: string; email: string; tempPassword?: string }[],
        failed: [] as { userId: string; error: string }[],
      };

      for (const userId of userIds) {
        try {
          const user = await storage.getUser(userId);
          if (!user) {
            results.failed.push({ userId, error: "User not found" });
            continue;
          }

          if (setPassword) {
            // Set a new temporary password directly
            const tempPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8).toUpperCase();
            const hashedPassword = await hashPassword(tempPassword);
            await storage.updateUser(userId, { password: hashedPassword });
            results.successful.push({ userId, email: user.email, tempPassword });
          } else {
            // Generate reset token (user will receive email to reset)
            const crypto = await import("crypto");
            const token = crypto.randomBytes(32).toString("hex");
            const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
            await storage.updateUser(userId, { 
              passwordResetToken: token, 
              passwordResetExpires: expires 
            });
            results.successful.push({ userId, email: user.email });
          }
        } catch (error: any) {
          results.failed.push({ userId, error: error.message || "Unknown error" });
        }
      }

      res.json({
        message: `Password reset initiated for ${results.successful.length} users, ${results.failed.length} failed`,
        successful: results.successful,
        failed: results.failed,
      });
    } catch (error) {
      next(error);
    }
  });

  // Admin: Send welcome emails to users
  app.post("/api/admin/users/send-welcome-emails", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const sendEmailSchema = z.object({
        userIds: z.array(z.string().uuid()).min(1, "At least one user ID required"),
      });
      
      const parseResult = sendEmailSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: "Invalid request", errors: parseResult.error.flatten() });
      }
      
      const { userIds } = parseResult.data;
      const { hashPassword } = await import("./auth");
      const { sendWelcomeEmail } = await import("./email");
      const crypto = await import("crypto");
      
      // Use production URL for welcome emails
      const loginUrl = 'https://mentorship.sonsiel.org/login';

      const results = {
        successful: [] as { userId: string; email: string }[],
        failed: [] as { userId: string; email: string; error: string; tempPassword?: string }[],
      };

      for (const userId of userIds) {
        try {
          const user = await storage.getUser(userId);
          if (!user) {
            results.failed.push({ userId, email: "unknown", error: "User not found" });
            continue;
          }

          // Generate cryptographically secure temporary password
          const tempPassword = crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16);

          // Try to send email FIRST before changing password
          const emailResult = await sendWelcomeEmail({
            email: user.email,
            firstName: user.firstName || "",
            lastName: user.lastName || "",
            temporaryPassword: tempPassword,
            loginUrl,
          });

          if (emailResult.success) {
            // Only update password after successful email send
            const hashedPassword = await hashPassword(tempPassword);
            await storage.updateUser(userId, { password: hashedPassword });
            results.successful.push({ userId, email: user.email });
          } else {
            // Email failed - don't change password, include temp password in case admin wants to retry
            results.failed.push({ userId, email: user.email, error: emailResult.error || "Email send failed", tempPassword });
          }
        } catch (error: any) {
          const user = await storage.getUser(userId);
          results.failed.push({ userId, email: user?.email || "unknown", error: error.message || "Unknown error" });
        }
      }

      const audit = AuditService.fromRequest(req);
      for (const s of results.successful) {
        await audit.log({
          action: 'EMAIL_SENT',
          resourceType: 'USER',
          resourceId: s.userId,
          resourceName: s.email,
          metadata: { emailType: 'welcome', recipient: s.email, sentBy: req.user!.email },
        });
      }
      for (const f of results.failed) {
        await audit.log({
          action: 'EMAIL_SENT',
          resourceType: 'USER',
          resourceId: f.userId,
          resourceName: f.email,
          success: false,
          errorMessage: f.error,
          metadata: { emailType: 'welcome', recipient: f.email, sentBy: req.user!.email },
        });
      }

      res.json({
        message: `Welcome emails sent to ${results.successful.length} users, ${results.failed.length} failed`,
        successful: results.successful,
        failed: results.failed,
      });
    } catch (error) {
      next(error);
    }
  });

  // Admin: ping a user with a custom message — creates an in-app
  // notification, pushes it live via Ably, and sends an email.
  app.post("/api/admin/users/:id/ping", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const pingSchema = z.object({
        subject: z.string().max(200).optional(),
        message: z.string().min(1, "Message required").max(5000),
      });
      const parseResult = pingSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: "Invalid request", errors: parseResult.error.flatten() });
      }
      const { subject, message } = parseResult.data;
      const targetId = req.params.id;

      const target = await storage.getUser(targetId);
      if (!target) {
        return res.status(404).json({ message: "User not found" });
      }

      const sender = req.user as any;
      const senderName = `${sender.firstName} ${sender.lastName}`;
      const title = subject || `Message from ${senderName}`;

      const notification = await storage.createNotification({
        userId: targetId,
        type: "SYSTEM_ANNOUNCEMENT",
        title,
        message,
        priority: "NORMAL",
      });

      // Push live + bump bell badge
      emitNotification(targetId, notification);
      const unreadCount = await storage.getUnreadNotificationCount(targetId);
      emitNotificationCountUpdate(targetId, unreadCount);

      // Send email — non-blocking; failure logged but doesn't fail the request
      const { sendAdminPingEmail, getTrustedBaseUrl } = await import("./email");
      sendAdminPingEmail({
        email: target.email,
        recipientName: `${target.firstName} ${target.lastName}`,
        senderName,
        subject: title,
        message,
        dashboardUrl: getTrustedBaseUrl(),
      }).catch((err) => console.error("[ping] email send failed:", err));

      res.json({ success: true, notificationId: notification.id });
    } catch (error) {
      next(error);
    }
  });

  // ============ MENTOR PROFILES ============

  // Admin: Get all mentor profiles with filters
  app.get("/api/admin/mentor-profiles", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const filters = {
        status: req.query.status as string | undefined,
        region: req.query.region as string | undefined,
        track: req.query.track as string | undefined,
        language: req.query.language as string | undefined,
        cohortYear: req.query.cohortYear ? parseInt(req.query.cohortYear as string) : undefined,
        hasCapacity: req.query.hasCapacity === "true",
        search: req.query.search as string | undefined,
      };
      
      const profiles = await storage.getMentorProfiles(filters);
      res.json(profiles);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Get single mentor profile by user ID
  app.get("/api/admin/mentor-profiles/:userId", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const profile = await storage.getMentorProfile(req.params.userId);
      if (!profile) {
        return res.status(404).json({ message: "Mentor profile not found" });
      }
      
      const user = await storage.getUser(req.params.userId);
      res.json({ ...profile, user });
    } catch (error) {
      next(error);
    }
  });

  // Admin: Create mentor profile for a user
  app.post("/api/admin/mentor-profiles", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { userId, ...profileData } = req.body;
      
      if (!userId) {
        return res.status(400).json({ message: "User ID is required" });
      }

      // Check if user exists and is a mentor
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(400).json({ message: "User must have MENTOR, ADMIN, or SUPER_ADMIN role" });
      }

      // Check if profile already exists
      const existingProfile = await storage.getMentorProfile(userId);
      if (existingProfile) {
        return res.status(400).json({ message: "Mentor profile already exists for this user" });
      }

      const profile = await storage.createMentorProfile({
        userId,
        ...profileData,
      });

      res.status(201).json(profile);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Update mentor profile
  app.patch("/api/admin/mentor-profiles/:userId", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const profile = await storage.updateMentorProfile(req.params.userId, req.body);
      if (!profile) {
        return res.status(404).json({ message: "Mentor profile not found" });
      }
      res.json(profile);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Delete mentor profile
  app.delete("/api/admin/mentor-profiles/:userId", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      await storage.deleteMentorProfile(req.params.userId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // Admin: Get mentors with available capacity
  app.get("/api/admin/mentor-profiles/with-capacity", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const cohortYear = req.query.cohortYear ? parseInt(req.query.cohortYear as string) : undefined;
      const mentors = await storage.getMentorsWithCapacity(cohortYear);
      res.json(mentors);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Export mentor profiles as CSV
  app.get("/api/admin/mentor-profiles/export", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const filters = {
        status: req.query.status as string | undefined,
        region: req.query.region as string | undefined,
        track: req.query.track as string | undefined,
        cohortYear: req.query.cohortYear ? parseInt(req.query.cohortYear as string) : undefined,
      };
      
      const profiles = await storage.getMentorProfiles(filters);
      
      const headers = [
        "Email", "Name", "Preferred Name", "Pronouns", "Region", "Languages",
        "Mentoring Tracks", "Expertise Description", "Skills to Share",
        "Mentoring Goals", "Meeting Frequency", "Meeting Format",
        "Additional Notes", "Status", "Cohort Year", "Max Mentees",
        "Current Mentees", "Organization", "Job Title"
      ];
      
      const rows = profiles.map(p => [
        p.user.email,
        `${p.user.firstName} ${p.user.lastName}`,
        p.preferredName || "",
        p.pronouns || "",
        p.region || "",
        (p.languages || []).join("; "),
        (p.mentoringTracks || []).join("; "),
        (p.expertiseDescription || "").replace(/"/g, '""'),
        (p.skillsToShare || "").replace(/"/g, '""'),
        (p.mentoringGoals || "").replace(/"/g, '""'),
        p.preferredMeetingFrequency || "",
        p.preferredMeetingFormat || "",
        (p.additionalNotes || "").replace(/"/g, '""'),
        p.status || "",
        p.cohortYear?.toString() || "",
        p.maxMentees?.toString() || "2",
        p.currentMenteeCount?.toString() || "0",
        p.user.organizationName || "",
        p.user.jobTitle || ""
      ]);

      const csv = [
        headers.join(","),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(","))
      ].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=mentor-profiles-export.csv");
      res.send(csv);
    } catch (error) {
      next(error);
    }
  });

  // Mentor: Get own profile (ADMIN/SUPER_ADMIN can also be mentors)
  app.get("/api/mentor/profile", requireRole("MENTOR", "ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
    try {
      const profile = await storage.getMentorProfile(req.user!.id);
      if (!profile) {
        return res.status(404).json({ message: "Mentor profile not found" });
      }
      res.json(profile);
    } catch (error) {
      next(error);
    }
  });

  // Mentor: Update own profile (limited fields) - ADMIN/SUPER_ADMIN can also be mentors
  app.patch("/api/mentor/profile", requireRole("MENTOR", "ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
    try {
      const allowedFields = [
        "preferredName",
        "pronouns",
        "languages",
        "additionalNotes",
        "preferredMeetingFrequency",
        "preferredMeetingFormat",
      ];

      const updates: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      const profile = await storage.updateMentorProfile(req.user!.id, updates);
      if (!profile) {
        return res.status(404).json({ message: "Mentor profile not found" });
      }
      res.json(profile);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Bulk import mentor profiles from survey CSV (uses mentorProfilesExtended table)
  app.post("/api/admin/mentor-profiles/bulk-import", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { profiles: profilesData, fieldMapping } = req.body;
      
      if (!Array.isArray(profilesData) || profilesData.length === 0) {
        return res.status(400).json({ message: "No profile data provided" });
      }

      const defaultMapping = {
        email: "email",
        biography: "biography",
        maxMentees: "max_mentees",
        preferredMenteeStages: "preferred_mentee_stages",
        openToMentoringOutsideExpertise: "open_to_mentoring_outside_expertise",
        previouslyServedAsMentor: "previously_served_as_mentor",
        mentorshipExperienceDescription: "mentorship_experience_description",
        certificationsTraining: "certifications_training",
        notableAchievements: "notable_achievements",
        industriesExperience: "industries_experience",
        skillsToShare: "skills_to_share",
        primaryMotivations: "primary_motivations",
        comfortScienceResearch: "comfort_science_research",
        comfortProductDevelopment: "comfort_product_development",
        comfortInnovation: "comfort_innovation",
        comfortBusinessStrategy: "comfort_business_strategy",
        comfortEntrepreneurship: "comfort_entrepreneurship",
        comfortIntrapreneurship: "comfort_intrapreneurship",
        comfortLeadership: "comfort_leadership",
        comfortNetworking: "comfort_networking",
        comfortProfessionalDevelopment: "comfort_professional_development",
        comfortDigitalTech: "comfort_digital_tech",
        comfortEthicalSocial: "comfort_ethical_social",
        monthlyHoursAvailable: "monthly_hours_available",
        availabilityNotes: "availability_notes",
        timezone: "timezone",
        preferredDuration: "preferred_duration",
        preferredCommunicationTools: "preferred_communication_tools",
        languagesSpoken: "languages_spoken",
      };

      const mapping = { ...defaultMapping, ...fieldMapping };
      
      const results = {
        successful: [] as any[],
        failed: [] as { row: number; email: string; error: string }[],
      };

      const parseArrayField = (value: string | undefined): string[] => {
        if (!value) return [];
        return value.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      };

      const parseBoolean = (value: string | undefined): boolean | undefined => {
        if (value === undefined || value === null || value === '') return undefined;
        const lower = String(value).toLowerCase().trim();
        if (lower === 'true' || lower === 'yes' || lower === '1') return true;
        if (lower === 'false' || lower === 'no' || lower === '0') return false;
        return undefined;
      };

      const parseInteger = (value: string | undefined, defaultVal: number = 0): number => {
        if (value === undefined || value === null || value === '') return defaultVal;
        const parsed = parseInt(String(value), 10);
        return isNaN(parsed) ? defaultVal : parsed;
      };

      for (let i = 0; i < profilesData.length; i++) {
        const data = profilesData[i];
        const email = data[mapping.email];

        try {
          if (!email) {
            throw new Error("Email is required");
          }

          const user = await storage.getUserByEmail(email);
          if (!user) {
            throw new Error(`User not found with email: ${email}`);
          }

          if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
            throw new Error(`User ${email} must have MENTOR, ADMIN, or SUPER_ADMIN role`);
          }

          const existingProfile = await storage.getMentorProfileExtended(user.id);
          
          const profileData: any = {
            userId: user.id,
            biography: data[mapping.biography] || null,
            maxMentees: parseInteger(data[mapping.maxMentees], 2),
            preferredMenteeStages: parseArrayField(data[mapping.preferredMenteeStages]),
            openToMentoringOutsideExpertise: parseBoolean(data[mapping.openToMentoringOutsideExpertise]) ?? false,
            previouslyServedAsMentor: parseBoolean(data[mapping.previouslyServedAsMentor]),
            mentorshipExperienceDescription: data[mapping.mentorshipExperienceDescription] || null,
            certificationsTraining: data[mapping.certificationsTraining] || null,
            notableAchievements: data[mapping.notableAchievements] || null,
            industriesExperience: parseArrayField(data[mapping.industriesExperience]),
            skillsToShare: data[mapping.skillsToShare] || null,
            primaryMotivations: data[mapping.primaryMotivations] || null,
            comfortScienceResearch: parseInteger(data[mapping.comfortScienceResearch], 0),
            comfortProductDevelopment: parseInteger(data[mapping.comfortProductDevelopment], 0),
            comfortInnovation: parseInteger(data[mapping.comfortInnovation], 0),
            comfortBusinessStrategy: parseInteger(data[mapping.comfortBusinessStrategy], 0),
            comfortEntrepreneurship: parseInteger(data[mapping.comfortEntrepreneurship], 0),
            comfortIntrapreneurship: parseInteger(data[mapping.comfortIntrapreneurship], 0),
            comfortLeadership: parseInteger(data[mapping.comfortLeadership], 0),
            comfortNetworking: parseInteger(data[mapping.comfortNetworking], 0),
            comfortProfessionalDevelopment: parseInteger(data[mapping.comfortProfessionalDevelopment], 0),
            comfortDigitalTech: parseInteger(data[mapping.comfortDigitalTech], 0),
            comfortEthicalSocial: parseInteger(data[mapping.comfortEthicalSocial], 0),
            monthlyHoursAvailable: data[mapping.monthlyHoursAvailable] || null,
            availabilityNotes: data[mapping.availabilityNotes] || null,
            timezone: data[mapping.timezone] || null,
            preferredDuration: data[mapping.preferredDuration] || null,
            preferredCommunicationTools: parseArrayField(data[mapping.preferredCommunicationTools]),
            languagesSpoken: parseArrayField(data[mapping.languagesSpoken]),
          };

          let profile;
          if (existingProfile) {
            profile = await storage.updateMentorProfileExtended(user.id, profileData);
          } else {
            profile = await storage.createMentorProfileExtended(profileData);
          }

          results.successful.push({ email, userId: user.id, profile });
        } catch (error: any) {
          results.failed.push({
            row: i + 1,
            email: email || "unknown",
            error: error.message || "Unknown error",
          });
        }
      }

      res.json({
        message: `Imported ${results.successful.length} profiles, ${results.failed.length} failed`,
        successful: results.successful,
        failed: results.failed,
      });
    } catch (error) {
      next(error);
    }
  });

  // Download CSV template for mentor profile bulk import (mentorProfilesExtended)
  app.get("/api/admin/mentor-profiles/bulk-import/template", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res) => {
    const headers = [
      "email",
      "biography",
      "max_mentees",
      "preferred_mentee_stages",
      "open_to_mentoring_outside_expertise",
      "previously_served_as_mentor",
      "mentorship_experience_description",
      "certifications_training",
      "notable_achievements",
      "industries_experience",
      "skills_to_share",
      "primary_motivations",
      "comfort_science_research",
      "comfort_product_development",
      "comfort_innovation",
      "comfort_business_strategy",
      "comfort_entrepreneurship",
      "comfort_intrapreneurship",
      "comfort_leadership",
      "comfort_networking",
      "comfort_professional_development",
      "comfort_digital_tech",
      "comfort_ethical_social",
      "monthly_hours_available",
      "availability_notes",
      "timezone",
      "preferred_duration",
      "preferred_communication_tools",
      "languages_spoken"
    ];
    
    const exampleRow = [
      "mentor@example.com",
      "Experienced healthcare leader with 15 years in hospital administration",
      "2",
      "early_career,mid_career",
      "true",
      "true",
      "10 years mentoring experience in healthcare",
      "Leadership certification, PMP",
      "Led successful startup, published researcher",
      "Healthcare,Technology,Research",
      "Strategic planning, Career development",
      "Give back to the community",
      "2",
      "1",
      "2",
      "2",
      "1",
      "1",
      "2",
      "2",
      "2",
      "1",
      "2",
      "3-4",
      "Available evenings and weekends",
      "America/New_York",
      "6_months",
      "Zoom,Google Meet",
      "English,Spanish"
    ];

    const csv = [headers.join(","), exampleRow.join(",")].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=mentor-profile-import-template.csv");
    res.send(csv);
  });

  // Admin: Bulk import mentee profiles from survey CSV
  app.post("/api/admin/mentee-profiles/bulk-import", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { profiles: profilesData, fieldMapping } = req.body;
      
      if (!Array.isArray(profilesData) || profilesData.length === 0) {
        return res.status(400).json({ message: "No profile data provided" });
      }

      const defaultMapping = {
        email: "email",
        biography: "biography",
        careerStage: "career_stage",
        shortTermGoals: "short_term_goals",
        longTermVision: "long_term_vision",
        currentProjectOrIdea: "current_project_or_idea",
        previouslyBeenMentored: "previously_been_mentored",
        mentorshipExperienceDescription: "mentorship_experience_description",
        interestScienceResearch: "interest_science_research",
        interestProductDevelopment: "interest_product_development",
        interestInnovation: "interest_innovation",
        interestBusinessStrategy: "interest_business_strategy",
        interestEntrepreneurship: "interest_entrepreneurship",
        interestIntrapreneurship: "interest_intrapreneurship",
        interestLeadership: "interest_leadership",
        interestNetworking: "interest_networking",
        interestProfessionalDevelopment: "interest_professional_development",
        interestDigitalTech: "interest_digital_tech",
        interestEthicalSocial: "interest_ethical_social",
        monthlyHoursAvailable: "monthly_hours_available",
        timezone: "timezone",
        preferredDuration: "preferred_duration",
        preferredCommunicationTools: "preferred_communication_tools",
      };

      const mapping = { ...defaultMapping, ...fieldMapping };
      
      const results = {
        successful: [] as any[],
        failed: [] as { row: number; email: string; error: string }[],
      };

      const parseArrayField = (value: string | undefined): string[] => {
        if (!value) return [];
        return value.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      };

      const parseBoolean = (value: string | undefined): boolean | undefined => {
        if (value === undefined || value === null || value === '') return undefined;
        const lower = String(value).toLowerCase().trim();
        if (lower === 'true' || lower === 'yes' || lower === '1') return true;
        if (lower === 'false' || lower === 'no' || lower === '0') return false;
        return undefined;
      };

      const parseInteger = (value: string | undefined, defaultVal: number = 0): number => {
        if (value === undefined || value === null || value === '') return defaultVal;
        const parsed = parseInt(String(value), 10);
        return isNaN(parsed) ? defaultVal : parsed;
      };

      for (let i = 0; i < profilesData.length; i++) {
        const data = profilesData[i];
        const email = data[mapping.email];

        try {
          if (!email) {
            throw new Error("Email is required");
          }

          const user = await storage.getUserByEmail(email);
          if (!user) {
            throw new Error(`User not found with email: ${email}`);
          }

          if (user.role !== "MENTEE") {
            throw new Error(`User ${email} is not a mentee`);
          }

          const existingProfile = await storage.getMenteeProfile(user.id);
          
          const profileData: any = {
            userId: user.id,
            biography: data[mapping.biography] || null,
            careerStage: data[mapping.careerStage] || null,
            shortTermGoals: data[mapping.shortTermGoals] || null,
            longTermVision: data[mapping.longTermVision] || null,
            currentProjectOrIdea: data[mapping.currentProjectOrIdea] || null,
            previouslyBeenMentored: parseBoolean(data[mapping.previouslyBeenMentored]),
            mentorshipExperienceDescription: data[mapping.mentorshipExperienceDescription] || null,
            interestScienceResearch: parseInteger(data[mapping.interestScienceResearch], 0),
            interestProductDevelopment: parseInteger(data[mapping.interestProductDevelopment], 0),
            interestInnovation: parseInteger(data[mapping.interestInnovation], 0),
            interestBusinessStrategy: parseInteger(data[mapping.interestBusinessStrategy], 0),
            interestEntrepreneurship: parseInteger(data[mapping.interestEntrepreneurship], 0),
            interestIntrapreneurship: parseInteger(data[mapping.interestIntrapreneurship], 0),
            interestLeadership: parseInteger(data[mapping.interestLeadership], 0),
            interestNetworking: parseInteger(data[mapping.interestNetworking], 0),
            interestProfessionalDevelopment: parseInteger(data[mapping.interestProfessionalDevelopment], 0),
            interestDigitalTech: parseInteger(data[mapping.interestDigitalTech], 0),
            interestEthicalSocial: parseInteger(data[mapping.interestEthicalSocial], 0),
            monthlyHoursAvailable: data[mapping.monthlyHoursAvailable] || null,
            timezone: data[mapping.timezone] || null,
            preferredDuration: data[mapping.preferredDuration] || null,
            preferredCommunicationTools: parseArrayField(data[mapping.preferredCommunicationTools]),
          };

          let profile;
          if (existingProfile) {
            profile = await storage.updateMenteeProfile(user.id, profileData);
          } else {
            profile = await storage.createMenteeProfile(profileData);
          }

          results.successful.push({ email, userId: user.id, profile });
        } catch (error: any) {
          results.failed.push({
            row: i + 1,
            email: email || "unknown",
            error: error.message || "Unknown error",
          });
        }
      }

      res.json({
        message: `Imported ${results.successful.length} profiles, ${results.failed.length} failed`,
        successful: results.successful,
        failed: results.failed,
      });
    } catch (error) {
      next(error);
    }
  });

  // Download CSV template for mentee profile bulk import
  app.get("/api/admin/mentee-profiles/bulk-import/template", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res) => {
    const headers = [
      "email",
      "biography",
      "career_stage",
      "short_term_goals",
      "long_term_vision",
      "current_project_or_idea",
      "previously_been_mentored",
      "mentorship_experience_description",
      "interest_science_research",
      "interest_product_development",
      "interest_innovation",
      "interest_business_strategy",
      "interest_entrepreneurship",
      "interest_intrapreneurship",
      "interest_leadership",
      "interest_networking",
      "interest_professional_development",
      "interest_digital_tech",
      "interest_ethical_social",
      "monthly_hours_available",
      "timezone",
      "preferred_duration",
      "preferred_communication_tools"
    ];
    
    const exampleRow = [
      "mentee@example.com",
      "Recent nursing graduate passionate about healthcare innovation",
      "early_career",
      "Get promoted to senior position",
      "Become a healthcare innovation leader",
      "Developing a new patient care workflow",
      "false",
      "",
      "2",
      "1",
      "2",
      "1",
      "2",
      "1",
      "2",
      "2",
      "2",
      "1",
      "2",
      "3-4",
      "America/New_York",
      "6_months",
      "Zoom,Google Meet"
    ];

    const csv = [headers.join(","), exampleRow.join(",")].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=mentee-profile-import-template.csv");
    res.send(csv);
  });

  // ============ MENTEE PROFILES CRUD ============
  
  // Admin: Export mentee profiles as CSV (must be before :userId route)
  app.get("/api/admin/mentee-profiles/export", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const filters = {
        careerStage: req.query.careerStage as string | undefined,
      };
      
      const profiles = await storage.getMenteeProfiles(filters);
      
      const headers = [
        "Email", "Name", "Career Stage", "Short Term Goals", "Long Term Vision",
        "Current Project", "Previously Mentored", "Timezone",
        "Monthly Hours", "Preferred Duration", "Organization", "Job Title"
      ];
      
      const rows = profiles.map(p => [
        p.user.email,
        `${p.user.firstName} ${p.user.lastName}`,
        p.careerStage || "",
        (p.shortTermGoals || "").replace(/"/g, '""'),
        (p.longTermVision || "").replace(/"/g, '""'),
        (p.currentProjectOrIdea || "").replace(/"/g, '""'),
        p.previouslyBeenMentored ? "Yes" : "No",
        p.timezone || "",
        p.monthlyHoursAvailable || "",
        p.preferredDuration || "",
        p.user.organizationName || "",
        p.user.jobTitle || ""
      ]);

      const csv = [
        headers.join(","),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(","))
      ].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=mentee-profiles-export.csv");
      res.send(csv);
    } catch (error) {
      next(error);
    }
  });
  
  // Admin: Get all mentee profiles with filters
  app.get("/api/admin/mentee-profiles", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const filters = {
        careerStage: req.query.careerStage as string | undefined,
        search: req.query.search as string | undefined,
      };
      
      const profiles = await storage.getMenteeProfiles(filters);
      res.json(profiles);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Get single mentee profile by user ID
  app.get("/api/admin/mentee-profiles/:userId", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const profile = await storage.getMenteeProfile(req.params.userId);
      if (!profile) {
        return res.status(404).json({ message: "Mentee profile not found" });
      }
      
      const user = await storage.getUser(req.params.userId);
      res.json({ ...profile, user });
    } catch (error) {
      next(error);
    }
  });

  // Admin: Create mentee profile for a user
  app.post("/api/admin/mentee-profiles", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { userId, ...profileData } = req.body;
      
      if (!userId) {
        return res.status(400).json({ message: "User ID is required" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      if (user.role !== "MENTEE") {
        return res.status(400).json({ message: "User must have MENTEE role" });
      }

      const existingProfile = await storage.getMenteeProfile(userId);
      if (existingProfile) {
        return res.status(400).json({ message: "Mentee profile already exists for this user" });
      }

      const profile = await storage.createMenteeProfile({
        userId,
        ...profileData,
      });

      res.status(201).json(profile);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Update mentee profile
  app.patch("/api/admin/mentee-profiles/:userId", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const profile = await storage.updateMenteeProfile(req.params.userId, req.body);
      if (!profile) {
        return res.status(404).json({ message: "Mentee profile not found" });
      }
      res.json(profile);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Delete mentee profile
  app.delete("/api/admin/mentee-profiles/:userId", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      await storage.deleteMenteeProfile(req.params.userId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/profile", requireAuth, async (req, res, next) => {
    try {
      const { password: _, ...safeUser } = req.user!;
      
      const [menteeProfile, mentorProfileExtended] = await Promise.all([
        storage.getMenteeProfile(req.user!.id),
        storage.getMentorProfileExtended(req.user!.id),
      ]);

      res.json({
        ...safeUser,
        menteeProfile: menteeProfile || null,
        mentorProfileExtended: mentorProfileExtended || null,
      });
    } catch (error) {
      next(error);
    }
  });

  // Server-mediated profile photo delivery. The Blob store is private,
  // so direct <img src={blobUrl}> won't work — clients hit this route
  // and we stream from Blob using the SDK (which adds the read token).
  app.get("/api/profile-photo/:userId", requireAuth, async (req, res, next) => {
    try {
      const targetUser = await storage.getUser(req.params.userId);
      if (!targetUser || !targetUser.profileImage) {
        return res.status(404).json({ message: "Photo not found" });
      }

      if (!isBlobUrl(targetUser.profileImage)) {
        // Legacy GCS path: data is unreachable on Vercel. 404 explicitly so
        // the UI shows initials rather than a hanging request.
        return res.status(404).json({
          message: "Photo unavailable. Please re-upload your profile photo.",
        });
      }

      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      await streamBlobToResponse(targetUser.profileImage, res, {
        cacheControl: "private, max-age=3600",
      });
    } catch (error: any) {
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ message: "Photo not found" });
      }
      next(error);
    }
  });

  // Get complete profile data (must be before /api/profile/:userId to avoid :userId capturing "complete")
  app.get("/api/profile/complete", requireAuth, async (req, res, next) => {
    try {
      const userId = req.user!.id;
      
      const [professionalProfile, mentorshipRole, menteeProfile, mentorProfileExtended] = await Promise.all([
        storage.getProfessionalProfile(userId),
        storage.getMentorshipRole(userId),
        storage.getMenteeProfile(userId),
        storage.getMentorProfileExtended(userId),
      ]);

      const { password: _, ...safeUser } = req.user!;
      
      res.json({
        user: safeUser,
        professionalProfile,
        mentorshipRole: mentorshipRole?.mentorshipRole || null,
        menteeProfile,
        mentorProfileExtended,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/profile/:userId", requireAuth, async (req, res, next) => {
    try {
      const currentUser = req.user!;
      const targetUserId = req.params.userId;

      let targetUser;
      if (currentUser.id === targetUserId) {
        targetUser = currentUser;
      } else if (currentUser.role === "SUPER_ADMIN" || currentUser.role === "ADMIN") {
        targetUser = await storage.getUser(targetUserId);
        if (!targetUser) return res.status(404).json({ message: "User not found" });
      } else {
        const matches = await storage.getMatchesForUser(currentUser.id);
        const isConnected = matches.some(match => {
          if (match.status !== "ACTIVE" && match.status !== "PROPOSED" && match.status !== "PAUSED") return false;
          return (match.mentor?.id === targetUserId) || (match.mentee?.id === targetUserId);
        });

        if (!isConnected) {
          return res.status(403).json({ message: "You can only view profiles of your connected mentors or mentees" });
        }

        targetUser = await storage.getUser(targetUserId);
        if (!targetUser) return res.status(404).json({ message: "User not found" });
      }

      const { password: _, ...safeUser } = targetUser;

      const [menteeProfile, mentorProfileExtended] = await Promise.all([
        storage.getMenteeProfile(targetUserId),
        storage.getMentorProfileExtended(targetUserId),
      ]);

      res.json({
        ...safeUser,
        menteeProfile: menteeProfile || null,
        mentorProfileExtended: mentorProfileExtended || null,
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/profile", requireAuth, async (req, res, next) => {
    try {
      const allowedFields = [
        "firstName",
        "lastName",
        "phone",
        "timezone",
        "preferredLanguage",
        "languagesSpoken",
        "bio",
        "linkedInUrl",
        "organizationName",
        "jobTitle",
        "yearsOfExperience",
        "yearsInSielAreas",
        "fieldsOfExpertise",
        "educationLevel",
        "certificationsTraining",
        "mentorshipRoleChoice",
        "isSonsielMember",
        "interestedInMembership",
        "profileImage",
      ];

      const updates: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      const updatedUser = await storage.updateUser(req.user!.id, updates);
      
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const { password: _, ...safeUser } = updatedUser;
      res.json(safeUser);
    } catch (error) {
      next(error);
    }
  });

  // Extended profile setup - saves all profile data in one request
  app.post("/api/profile/setup", requireAuth, async (req, res, next) => {
    try {
      const userId = req.user!.id;
      const { 
        userUpdates,
        professionalProfile,
        mentorshipRole,
        menteeProfile,
        mentorProfileExtended
      } = req.body;

      // Update user fields if provided
      if (userUpdates || mentorshipRole) {
        await storage.updateUser(userId, {
          ...(userUpdates || {}),
          ...(mentorshipRole ? { mentorshipRoleChoice: mentorshipRole } : {}),
          isProfileComplete: true,
        });
      }

      // Save professional profile
      if (professionalProfile) {
        const existing = await storage.getProfessionalProfile(userId);
        if (existing) {
          await storage.updateProfessionalProfile(userId, professionalProfile);
        } else {
          await storage.createProfessionalProfile({ userId, ...professionalProfile });
        }
      }

      // Save mentorship role
      if (mentorshipRole) {
        const existing = await storage.getMentorshipRole(userId);
        if (existing) {
          await storage.updateMentorshipRole(userId, { mentorshipRole });
        } else {
          await storage.createMentorshipRole({ userId, mentorshipRole });
        }
      }

      // Save mentee profile if seeking mentor or both
      if (menteeProfile && (mentorshipRole === 'seeking_mentor' || mentorshipRole === 'both')) {
        const existing = await storage.getMenteeProfile(userId);
        if (existing) {
          await storage.updateMenteeProfile(userId, menteeProfile);
        } else {
          await storage.createMenteeProfile({ userId, ...menteeProfile });
        }
      }

      // Save extended mentor profile if providing mentorship or both
      if (mentorProfileExtended && (mentorshipRole === 'providing_mentorship' || mentorshipRole === 'both')) {
        const existing = await storage.getMentorProfileExtended(userId);
        if (existing) {
          await storage.updateMentorProfileExtended(userId, mentorProfileExtended);
        } else {
          await storage.createMentorProfileExtended({ userId, ...mentorProfileExtended });
        }
      }

      // Update onboarding progress
      const onboarding = await storage.getOnboardingProgress(userId);
      if (onboarding) {
        await storage.updateOnboardingProgress(userId, { hasSetupProfile: true });
      } else {
        await storage.createOnboardingProgress({ 
          userId, 
          hasSetupProfile: true,
          hasSeenWelcome: true,
        });
      }

      // Fetch updated user
      const updatedUser = await storage.getUser(userId);
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }
      
      const { password: _, ...safeUser } = updatedUser;

      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'PROFILE_UPDATED',
        resourceType: 'USER',
        resourceId: userId,
        resourceName: updatedUser.email,
        metadata: { mentorshipRole, sectionsUpdated: Object.keys(req.body).filter(k => req.body[k]) },
      });

      res.json({ 
        success: true, 
        user: safeUser,
        message: "Profile setup completed successfully" 
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tracks", requireAuth, async (req, res, next) => {
    try {
      const programId = (req.session as any).activeProgramId;
      const tracks = await storage.getAllTracks(programId || undefined);
      res.json(tracks);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cohorts", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const programId = (req.session as any).activeProgramId;
      const cohorts = await storage.getAllCohorts(programId || undefined);
      res.json(cohorts);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cohorts/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const cohort = await storage.getCohort(req.params.id);
      if (!cohort) {
        return res.status(404).json({ message: "Cohort not found" });
      }
      res.json(cohort);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cohorts", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const body = { ...req.body };
      if (body.startDate && typeof body.startDate === 'string') {
        body.startDate = new Date(body.startDate);
      }
      if (body.endDate && typeof body.endDate === 'string') {
        body.endDate = new Date(body.endDate);
      }
      if (body.applicationDeadline && typeof body.applicationDeadline === 'string') {
        body.applicationDeadline = new Date(body.applicationDeadline);
      }
      const validation = insertCohortSchema.safeParse(body);
      if (!validation.success) {
        return res.status(400).json({ message: "Invalid cohort data", errors: validation.error.flatten() });
      }
      const programId = (req.session as any).activeProgramId || null;
      const cohort = await storage.createCohort({ ...validation.data, createdById: req.user!.id, programId });
      res.status(201).json(cohort);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/cohorts/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const body = { ...req.body };
      if (body.startDate && typeof body.startDate === 'string') {
        body.startDate = new Date(body.startDate);
      }
      if (body.endDate && typeof body.endDate === 'string') {
        body.endDate = new Date(body.endDate);
      }
      if (body.applicationDeadline && typeof body.applicationDeadline === 'string') {
        body.applicationDeadline = new Date(body.applicationDeadline);
      }
      const cohort = await storage.updateCohort(req.params.id, body);
      if (!cohort) {
        return res.status(404).json({ message: "Cohort not found" });
      }
      res.json(cohort);
    } catch (error) {
      next(error);
    }
  });

  // Bulk assign users to a cohort by role
  app.post("/api/cohorts/:cohortId/bulk-assign", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { cohortId } = req.params;
      const { role, userIds, trackId } = req.body;
      
      // Verify cohort exists
      const cohort = await storage.getCohort(cohortId);
      if (!cohort) {
        return res.status(404).json({ message: "Cohort not found" });
      }
      
      // Get users to assign (either specified userIds or all users of a role)
      let usersToAssign: any[] = [];
      if (userIds && userIds.length > 0) {
        // Assign specific users
        const allUsers = await storage.getAllUsers({ isActive: true });
        usersToAssign = allUsers.filter(u => userIds.includes(u.id));
      } else if (role) {
        // Assign all users of a specific role
        usersToAssign = await storage.getAllUsers({ role, isActive: true });
      } else {
        return res.status(400).json({ message: "Either role or userIds is required" });
      }
      
      const results = { added: 0, skipped: 0, errors: [] as string[] };
      
      for (const user of usersToAssign) {
        try {
          // Check if user is already a member
          const existing = await storage.getMembershipByUserAndCohort(user.id, cohortId);
          if (existing) {
            results.skipped++;
            continue;
          }
          
          // Determine role based on user's actual role
          const memberRole = user.role === 'MENTOR' ? 'MENTOR' : 'MENTEE';
          
          // Create membership
          await storage.createMembership({
            cohortId,
            userId: user.id,
            role: memberRole,
            trackId: trackId || null,
            applicationStatus: 'APPROVED',
            matchStatus: 'UNMATCHED',
            joinedAt: new Date(),
          });
          
          results.added++;
        } catch (err: any) {
          results.errors.push(`Failed to add ${user.email}: ${err.message}`);
        }
      }
      
      res.json({ 
        message: `Added ${results.added} users to cohort, ${results.skipped} already members`,
        ...results 
      });
    } catch (error) {
      next(error);
    }
  });

  // Get cohort members
  app.get("/api/cohorts/:cohortId/members", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const members = await storage.getCohortMembershipsWithUsers(req.params.cohortId);
      res.json(members);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/applications", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { status } = req.query;
      const applications = await storage.getMembershipsByStatus(status as string || 'PENDING');
      res.json(applications);
    } catch (error) {
      next(error);
    }
  });

  // ── Program Application Intake (public) ──────────────────────────────────
  app.post("/api/apply", async (req, res, next) => {
    try {
      const {
        firstName, lastName, email, preferredLanguage,
        isSonsielMember, interestedInMembership,
        currentTitle, institution, fieldsOfExpertise,
        educationLevel, healthcareYearsExp, innovationYearsExp,
        role, applicationData,
      } = req.body;

      if (!firstName || !lastName || !email || !role) {
        return res.status(400).json({ message: "First name, last name, email, and role are required" });
      }
      if (!["MENTOR", "MENTEE"].includes(role)) {
        return res.status(400).json({ message: "Role must be MENTOR or MENTEE" });
      }

      // Check for duplicate email
      const existing = await db.select().from(programApplicationsTable)
        .where(eq(programApplicationsTable.email, email.toLowerCase().trim()))
        .limit(1);
      if (existing.length > 0) {
        return res.status(409).json({ message: "An application with this email already exists" });
      }

      const [application] = await db.insert(programApplicationsTable).values({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.toLowerCase().trim(),
        preferredLanguage: preferredLanguage || "English",
        isSonsielMember: !!isSonsielMember,
        interestedInMembership: isSonsielMember ? null : (interestedInMembership ?? null),
        currentTitle: currentTitle || null,
        institution: institution || null,
        fieldsOfExpertise: fieldsOfExpertise || [],
        educationLevel: educationLevel || null,
        healthcareYearsExp: healthcareYearsExp || null,
        innovationYearsExp: innovationYearsExp || null,
        role,
        applicationData: applicationData || {},
        status: "PENDING",
      }).returning();

      res.status(201).json({ id: application.id, message: "Application submitted successfully" });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/admin/program-applications/stats
  // Returns counts by status for the pipeline overview banner
  app.get("/api/admin/program-applications/stats", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const statuses = ["PENDING", "REVIEWING", "APPROVED", "REJECTED", "WAITLISTED"] as const;
      const results = await Promise.all(
        statuses.map(async (status) => {
          const rows = await db.select().from(programApplicationsTable)
            .where(eq(programApplicationsTable.status, status));
          return [status, rows.length] as const;
        })
      );
      const byStatus = Object.fromEntries(results);
      const total = results.reduce((sum, [, n]) => sum + n, 0);
      res.json({ total, byStatus });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/program-applications", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { status } = req.query;
      const query = db.select().from(programApplicationsTable);
      const applications = status
        ? await query.where(eq(programApplicationsTable.status, status as any))
        : await query.orderBy(programApplicationsTable.submittedAt);
      res.json(applications);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/admin/program-applications/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status, adminNotes } = req.body;
      const adminUser = (req as any).user;

      const updates: Record<string, any> = { updatedAt: new Date() };
      if (status) {
        updates.status = status;
        updates.reviewedAt = new Date();
        updates.reviewedBy = adminUser?.id ?? null;
      }
      if (adminNotes !== undefined) updates.adminNotes = adminNotes;
      if ('assignedCohortId' in req.body) updates.assignedCohortId = req.body.assignedCohortId || null;

      const [updated] = await db.update(programApplicationsTable)
        .set(updates)
        .where(eq(programApplicationsTable.id, id))
        .returning();

      if (!updated) return res.status(404).json({ message: "Application not found" });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/admin/program-applications/bulk-status
  // Body: { ids: string[], status: string }
  app.post("/api/admin/program-applications/bulk-status", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { ids, status } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "ids must be a non-empty array" });
      }
      const validStatuses = ["PENDING", "REVIEWING", "APPROVED", "REJECTED", "WAITLISTED"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      const adminUser = (req as any).user;
      await db.update(programApplicationsTable)
        .set({ status, reviewedAt: new Date(), reviewedBy: adminUser?.id ?? null, updatedAt: new Date() })
        .where(inArray(programApplicationsTable.id, ids));
      res.json({ updated: ids.length });
    } catch (error) {
      next(error);
    }
  });

  // Assign an activated applicant to a cohort
  app.post("/api/admin/program-applications/:id/assign-cohort", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { cohortId } = req.body;

      if (!cohortId) return res.status(400).json({ message: "cohortId is required" });

      const [application] = await db.select().from(programApplicationsTable).where(eq(programApplicationsTable.id, id));
      if (!application) return res.status(404).json({ message: "Application not found" });
      if (!application.provisionedUserId) return res.status(400).json({ message: "Application must be activated before assigning a cohort" });

      const cohort = await storage.getCohort(cohortId);
      if (!cohort) return res.status(404).json({ message: "Cohort not found" });

      // Create membership if not already a member
      const existing = await storage.getMembershipByUserAndCohort(application.provisionedUserId, cohortId);
      if (!existing) {
        const provUser = await storage.getUser(application.provisionedUserId);
        const memberRole = provUser?.role === "MENTOR" ? "MENTOR" : "MENTEE";
        await storage.createMembership({
          cohortId,
          userId: application.provisionedUserId,
          role: memberRole,
          applicationStatus: "APPROVED",
          matchStatus: "UNMATCHED",
          joinedAt: new Date(),
        });
      }

      // Stamp the application with the assigned cohort
      const [updated] = await db.update(programApplicationsTable)
        .set({ assignedCohortId: cohortId, assignedCohortAt: new Date(), updatedAt: new Date() })
        .where(eq(programApplicationsTable.id, id))
        .returning();

      res.json({ application: updated, cohort, alreadyMember: !!existing });
    } catch (error) {
      next(error);
    }
  });

  // Activate a program application: provision user account + profiles + send set-password email
  app.post("/api/admin/program-applications/:id/activate", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;

      // 1. Fetch the application
      const [application] = await db.select().from(programApplicationsTable).where(eq(programApplicationsTable.id, id));
      if (!application) return res.status(404).json({ message: "Application not found" });
      if (application.provisionedUserId) return res.status(400).json({ message: "Account already provisioned" });

      // 2. Guard: application must be APPROVED
      if (application.status !== "APPROVED") {
        return res.status(400).json({ message: "Application must be in APPROVED status before activating" });
      }

      // 3. Check for duplicate email
      const existingUser = await storage.getUserByEmail(application.email);
      if (existingUser) {
        return res.status(400).json({ message: "A user account with this email already exists" });
      }

      // 4. Create user with a hashed placeholder password; user will set their own via token
      const { hashPassword } = await import("./auth");
      const { randomBytes } = await import("crypto");
      const placeholderPassword = randomBytes(32).toString("hex");
      const hashedPassword = await hashPassword(placeholderPassword);

      const newUser = await storage.createUser({
        email: application.email,
        password: hashedPassword,
        firstName: application.firstName,
        lastName: application.lastName,
        role: application.role as "MENTOR" | "MENTEE",
        isActive: true,
        isVerified: true,
        isProfileComplete: false,
        mustChangePassword: false,
      });

      // 5. Create professional profile from application fields
      try {
        await storage.createProfessionalProfile({
          userId: newUser.id,
          positionTitle: application.currentTitle || undefined,
          organization: application.institution || undefined,
          expertiseAreas: (application.fieldsOfExpertise as string[]) || [],
          highestEducation: application.educationLevel ? [application.educationLevel] : [],
          yearsInHealthcare: application.healthcareYearsExp || undefined,
          yearsInInnovation: application.innovationYearsExp || undefined,
        });
      } catch (profileErr) {
        console.warn("[ACTIVATE] Could not create professional profile:", profileErr);
      }

      // 6. Map applicationData → role-specific profile
      const appData = (application.applicationData as Record<string, any>) ?? {};

      if (application.role === "MENTEE") {
        const ratings = (appData.interestRatings as Record<string, number>) ?? {};
        const ratingVal = (v: unknown) => (typeof v === "number" ? Math.min(2, Math.max(0, v)) : 0);
        try {
          await storage.createMenteeProfile({
            userId: newUser.id,
            previouslyBeenMentored: appData.previouslyMentored ?? null,
            pastSuccesses: appData.pastSuccesses || null,
            pastChallenges: appData.pastChallenges || null,
            hopingToGain: Array.isArray(appData.hopingToGain) ? appData.hopingToGain : [],
            specificSkillsSeeking: appData.specificSkillsWanted || null,
            primaryMotivations: appData.primaryMotivations || null,
            preferredMethods: Array.isArray(appData.preferredMethods) ? appData.preferredMethods : [],
            interestScienceResearch: ratingVal(ratings.scienceResearch),
            interestProductDevelopment: ratingVal(ratings.productDevelopment),
            interestInnovation: ratingVal(ratings.innovation),
            interestBusinessStrategy: ratingVal(ratings.businessStrategy),
            interestEntrepreneurship: ratingVal(ratings.entrepreneurship),
            interestIntrapreneurship: ratingVal(ratings.intrapreneurship),
            interestLeadership: ratingVal(ratings.leadershipTeamManagement),
            interestNetworking: ratingVal(ratings.networking),
            interestProfessionalDevelopment: ratingVal(ratings.professionalDevelopment),
            interestDigitalTech: ratingVal(ratings.digitalTech),
            interestEthicalSocial: ratingVal(ratings.ethicalSocial),
            resourcesNeeded: appData.resourcesNeeded || null,
            programSuggestions: appData.programStructureSuggestions || null,
            effectiveStructures: appData.effectiveStructures || null,
            willingToPay: (() => {
              const v = (appData.willingToPay as string || "").toLowerCase();
              if (v === "yes") return "yes" as const;
              if (v === "no") return "no" as const;
              return "maybe" as const;
            })(),
          });
        } catch (profileErr) {
          console.warn("[ACTIVATE] Could not create mentee profile:", profileErr);
        }
      } else if (application.role === "MENTOR") {
        const ratings = (appData.comfortRatings as Record<string, number>) ?? {};
        const ratingVal = (v: unknown) => (typeof v === "number" ? Math.min(2, Math.max(0, v)) : 0);
        try {
          await storage.createMentorProfileExtended({
            userId: newUser.id,
            previouslyServedAsMentor: appData.previouslyMentored ?? null,
            mentorshipExperienceDescription: appData.mentorshipExperience || null,
            certificationsTraining: appData.certifications || null,
            skillsToShare: appData.specificSkillsToShare || null,
            primaryMotivations: appData.primaryMotivations || null,
            pastSuccesses: appData.pastSuccesses || null,
            pastChallenges: appData.pastChallenges || null,
            preferredMethods: Array.isArray(appData.preferredMethods) ? appData.preferredMethods : [],
            comfortScienceResearch: ratingVal(ratings.scienceResearch),
            comfortProductDevelopment: ratingVal(ratings.productDevelopment),
            comfortInnovation: ratingVal(ratings.innovation),
            comfortBusinessStrategy: ratingVal(ratings.businessStrategy),
            comfortEntrepreneurship: ratingVal(ratings.entrepreneurship),
            comfortIntrapreneurship: ratingVal(ratings.intrapreneurship),
            comfortLeadership: ratingVal(ratings.leadershipTeamManagement),
            comfortNetworking: ratingVal(ratings.networking),
            comfortProfessionalDevelopment: ratingVal(ratings.professionalDevelopment),
            comfortDigitalTech: ratingVal(ratings.digitalTech),
            comfortEthicalSocial: ratingVal(ratings.ethicalSocial),
            resourcesNeeded: appData.resourcesNeeded || null,
            programSuggestions: appData.programStructureSuggestions || null,
            effectiveStructures: appData.effectiveStructures || null,
            bestDaysTimes: appData.bestDaysTimes || null,
          });
        } catch (profileErr) {
          console.warn("[ACTIVATE] Could not create mentor profile:", profileErr);
        }
      }

      // 7. Generate a 7-day password-set token
      const resetToken = randomBytes(32).toString("hex");
      const resetExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await storage.updateUser(newUser.id, {
        passwordResetToken: resetToken,
        passwordResetExpires: resetExpires,
      });

      // 8. Send activation email
      const { sendAccountActivationEmail, getTrustedBaseUrl } = await import("./email");
      const baseUrl = getTrustedBaseUrl();
      const setPasswordUrl = `${baseUrl}/reset-password/${resetToken}`;
      const emailResult = await sendAccountActivationEmail({
        email: application.email,
        firstName: application.firstName,
        lastName: application.lastName,
        setPasswordUrl,
        role: application.role,
      });
      if (!emailResult.success) {
        console.warn("[ACTIVATE] Activation email failed:", emailResult.error);
      }

      // 9. Update application record
      const [updated] = await db.update(programApplicationsTable)
        .set({
          provisionedUserId: newUser.id,
          provisionedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(programApplicationsTable.id, id))
        .returning();

      // 10. Audit log
      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'USER_CREATED',
        resourceType: 'USER',
        resourceId: newUser.id,
        resourceName: newUser.email,
        metadata: {
          role: application.role,
          registrationMethod: 'application_activation',
          applicationId: id,
          emailSent: emailResult.success,
        },
      });

      res.json({ success: true, userId: newUser.id, application: updated });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/applications/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { applicationStatus, notes } = req.body;
      const membership = await storage.updateMembership(req.params.id, {
        applicationStatus,
        notes,
        joinedAt: applicationStatus === 'APPROVED' ? new Date() : undefined
      });
      if (!membership) {
        return res.status(404).json({ message: "Application not found" });
      }
      res.json(membership);
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // Application Questions Routes
  // ============================================
  
  // Get application questions (public for cohort applications)
  app.get("/api/cohorts/:cohortId/questions", async (req, res, next) => {
    try {
      const { forRole } = req.query;
      const questions = await storage.getApplicationQuestions(req.params.cohortId, forRole as string);
      res.json(questions);
    } catch (error) {
      next(error);
    }
  });

  // Get default questions (admin only)
  app.get("/api/application-questions/defaults", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const questions = await storage.getDefaultQuestions();
      res.json(questions);
    } catch (error) {
      next(error);
    }
  });

  // Create cohort-specific question (admin only)
  app.post("/api/cohorts/:cohortId/questions", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const validation = insertApplicationQuestionSchema.safeParse({
        ...req.body,
        cohortId: req.params.cohortId,
      });
      if (!validation.success) {
        return res.status(400).json({ message: "Invalid question data", errors: validation.error.flatten() });
      }
      const question = await storage.createApplicationQuestion(validation.data);
      res.status(201).json(question);
    } catch (error) {
      next(error);
    }
  });

  // Update question (admin only)
  app.patch("/api/application-questions/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const question = await storage.updateApplicationQuestion(req.params.id, req.body);
      if (!question) {
        return res.status(404).json({ message: "Question not found" });
      }
      res.json(question);
    } catch (error) {
      next(error);
    }
  });

  // Delete question (admin only)
  app.delete("/api/application-questions/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      await storage.deleteApplicationQuestion(req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // Public Application Routes
  // ============================================

  // Get public cohort info for application
  app.get("/api/public/cohorts/:id", async (req, res, next) => {
    try {
      const cohort = await storage.getCohort(req.params.id);
      if (!cohort || !cohort.isPublic) {
        return res.status(404).json({ message: "Cohort not found or not accepting applications" });
      }
      if (cohort.status !== 'RECRUITING') {
        return res.status(400).json({ message: "This cohort is not currently accepting applications" });
      }
      res.json({
        id: cohort.id,
        name: cohort.name,
        description: cohort.description,
        applicationDeadline: cohort.applicationDeadline,
        startDate: cohort.startDate,
        endDate: cohort.endDate,
      });
    } catch (error) {
      next(error);
    }
  });

  // Submit application (authenticated users)
  app.post("/api/cohorts/:cohortId/apply", requireAuth, async (req, res, next) => {
    try {
      const { role, trackId, responses } = req.body;
      const cohortId = req.params.cohortId;
      const userId = req.user!.id;

      // Check cohort exists and is recruiting
      const cohort = await storage.getCohort(cohortId);
      if (!cohort) {
        return res.status(404).json({ message: "Cohort not found" });
      }
      if (cohort.status !== 'RECRUITING') {
        return res.status(400).json({ message: "This cohort is not accepting applications" });
      }

      // Check if user already applied
      const existing = await storage.getMembershipByUserAndCohort(userId, cohortId);
      if (existing) {
        return res.status(400).json({ message: "You have already applied to this cohort" });
      }

      // Create membership (application)
      const membership = await storage.createMembership({
        cohortId,
        userId,
        role: role as any,
        trackId,
        applicationStatus: 'PENDING',
        applicationData: { submittedAt: new Date().toISOString() },
      });

      // Save application responses
      if (responses && Array.isArray(responses)) {
        for (const resp of responses) {
          await storage.createApplicationResponse({
            membershipId: membership.id,
            questionId: resp.questionId,
            response: resp.response,
          });
        }
      }

      res.status(201).json({ 
        message: "Application submitted successfully",
        applicationId: membership.id
      });
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // Matching Configuration Routes
  // ============================================

  // Get matching configuration for cohort
  app.get("/api/cohorts/:cohortId/matching-config", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      let config = await storage.getMatchingConfiguration(req.params.cohortId);
      if (!config) {
        // Return default configuration
        config = {
          id: '',
          cohortId: req.params.cohortId,
          languageWeight: 25,
          trackWeight: 20,
          expertiseWeight: 25,
          availabilityWeight: 15,
          experienceWeight: 10,
          communicationWeight: 5,
          minimumScore: 50,
          requireLanguageMatch: true,
          maxMenteesPerMentor: 3,
          createdAt: null,
          updatedAt: null,
        };
      }
      res.json(config);
    } catch (error) {
      next(error);
    }
  });

  // Create or update matching configuration
  app.put("/api/cohorts/:cohortId/matching-config", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const cohortId = req.params.cohortId;
      const existing = await storage.getMatchingConfiguration(cohortId);
      
      if (existing) {
        const config = await storage.updateMatchingConfiguration(cohortId, req.body);
        res.json(config);
      } else {
        const config = await storage.createMatchingConfiguration({ ...req.body, cohortId });
        res.status(201).json(config);
      }
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // Matching Routes
  // ============================================

  // Get unmatched participants for a cohort
  app.get("/api/cohorts/:cohortId/participants", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const cohortId = req.params.cohortId;
      const mentors = await storage.getUnmatchedMemberships(cohortId, 'MENTOR');
      const mentees = await storage.getUnmatchedMemberships(cohortId, 'MENTEE');
      
      // Get application responses for each participant
      const mentorsWithResponses = await Promise.all(mentors.map(async (m) => {
        const responses = await storage.getApplicationResponses(m.id);
        return { ...m, responses };
      }));
      
      const menteesWithResponses = await Promise.all(mentees.map(async (m) => {
        const responses = await storage.getApplicationResponses(m.id);
        return { ...m, responses };
      }));

      res.json({ mentors: mentorsWithResponses, mentees: menteesWithResponses });
    } catch (error) {
      next(error);
    }
  });

  // Get matches for a cohort
  app.get("/api/cohorts/:cohortId/matches", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const matches = await storage.getMatchesByCohort(req.params.cohortId);
      res.json(matches);
    } catch (error) {
      next(error);
    }
  });

  // Create a match
  app.post("/api/cohorts/:cohortId/matches", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { mentorMembershipId, menteeMembershipId, trackId, matchScore, matchReason } = req.body;
      const cohortId = req.params.cohortId;

      const match = await storage.createMatch({
        cohortId,
        mentorMembershipId,
        menteeMembershipId,
        trackId,
        status: 'PROPOSED',
        matchScore,
        matchReason,
        matchedAt: new Date(),
        matchedById: req.user!.id,
      });

      // Update membership match status
      await storage.updateMembership(mentorMembershipId, { matchStatus: 'MATCHED' });
      await storage.updateMembership(menteeMembershipId, { matchStatus: 'MATCHED' });

      // Send match notification emails to both participants (fire-and-forget)
      try {
        const [mentorMembership, menteeMembership, cohort] = await Promise.all([
          storage.getMembership(mentorMembershipId),
          storage.getMembership(menteeMembershipId),
          storage.getCohort(cohortId),
        ]);
        if (mentorMembership && menteeMembership && cohort) {
          const [mentorUser, menteeUser] = await Promise.all([
            storage.getUser(mentorMembership.userId),
            storage.getUser(menteeMembership.userId),
          ]);
          const { sendMatchNotificationEmail, getTrustedBaseUrl } = await import("./email");
          const baseUrl = getTrustedBaseUrl();
          if (mentorUser) {
            await sendMatchNotificationEmail({
              email: mentorUser.email,
              recipientName: `${mentorUser.firstName} ${mentorUser.lastName}`,
              recipientRole: 'MENTOR',
              partnerName: menteeUser ? `${menteeUser.firstName} ${menteeUser.lastName}` : 'your mentee',
              cohortName: cohort.name,
              dashboardUrl: baseUrl,
            });
          }
          if (menteeUser) {
            await sendMatchNotificationEmail({
              email: menteeUser.email,
              recipientName: `${menteeUser.firstName} ${menteeUser.lastName}`,
              recipientRole: 'MENTEE',
              partnerName: mentorUser ? `${mentorUser.firstName} ${mentorUser.lastName}` : 'your mentor',
              cohortName: cohort.name,
              dashboardUrl: baseUrl,
            });
          }
        }
      } catch (emailErr) {
        console.error('[MATCH] Failed to send match notification emails:', emailErr);
        // Non-fatal: match was created successfully
      }

      res.status(201).json(match);
    } catch (error) {
      next(error);
    }
  });

  // Get current user's matches (mentor or mentee)
  app.get("/api/matches/my", requireAuth, async (req, res, next) => {
    try {
      const userId = req.user!.id;
      const matches = await storage.getMatchesForUser(userId);
      res.json(matches);
    } catch (error) {
      next(error);
    }
  });

  // Update match status
  app.patch("/api/matches/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const match = await storage.updateMatch(req.params.id, req.body);
      if (!match) {
        return res.status(404).json({ message: "Match not found" });
      }
      res.json(match);
    } catch (error) {
      next(error);
    }
  });

  // Get all matches (admin view)
  app.get("/api/admin/matches", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const matches = await storage.getAllMatches();
      res.json(matches);
    } catch (error) {
      next(error);
    }
  });

  // Match health — engagement recency per active pair, so admins can spot
  // matches that have gone quiet before the cohort ends.
  app.get("/api/admin/match-health", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const rows = await storage.getMatchHealth();
      res.json(rows);
    } catch (error) {
      next(error);
    }
  });

  // Preview which pairs would be nudged. Read-only — sends nothing.
  app.get("/api/admin/match-nudges/preview", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const result = await runMatchNudges({ dryRun: true });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // Actually send the nudges. Separate endpoint from the preview on purpose:
  // sending real email to real people should never be a query-param away from
  // a read.
  app.post("/api/admin/match-nudges/send", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const result = await runMatchNudges({ dryRun: false });
      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: "MATCH_UPDATED",
        resourceType: "MATCH",
        resourceName: `${result.candidates.length} pair(s) nudged`,
        metadata: {
          matchIds: result.candidates.map((c) => c.matchId),
          recipients: result.delivered.length,
          emailsSent: result.delivered.filter((d) => d.emailed).length,
          failures: result.delivered.filter((d) => d.error).length,
        },
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // Scheduled counterpart to the /send endpoint above.
  //
  // Vercel Cron invokes this with `Authorization: Bearer $CRON_SECRET`, which
  // it derives from the env var of the same name. There is no session here, so
  // the shared secret is the only thing standing between a GET and real email
  // going out — if it isn't configured we refuse to run rather than falling
  // back to an open endpoint.
  app.get("/api/cron/match-nudges", async (req, res, next) => {
    try {
      const secret = process.env.CRON_SECRET;
      if (!secret) {
        return res.status(503).json({ message: "CRON_SECRET is not configured" });
      }
      if (req.get("authorization") !== `Bearer ${secret}`) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const result = await runMatchNudges({ dryRun: false });
      await AuditService.scheduledJob().log({
        action: "SCHEDULED_JOB_EXECUTED",
        resourceType: "MATCH",
        resourceName: `match-nudges: ${result.candidates.length} pair(s) nudged`,
        metadata: {
          matchIds: result.candidates.map((c) => c.matchId),
          recipients: result.delivered.length,
          emailsSent: result.delivered.filter((d) => d.emailed).length,
          failures: result.delivered.filter((d) => d.error).length,
        },
      });

      // Keep the response small — cron logs don't need the full candidate list.
      res.json({
        nudged: result.candidates.length,
        recipients: result.delivered.length,
        emailsSent: result.delivered.filter((d) => d.emailed).length,
        failures: result.delivered.filter((d) => d.error).length,
      });
    } catch (error) {
      next(error);
    }
  });

  // Get available mentors for matching
  app.get("/api/admin/matches/available-mentors", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const mentors = await storage.getAvailableMentors();
      res.json(mentors);
    } catch (error) {
      next(error);
    }
  });

  // Get available mentees for matching
  app.get("/api/admin/matches/available-mentees", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const mentees = await storage.getAvailableMentees();
      res.json(mentees);
    } catch (error) {
      next(error);
    }
  });

  // Create a simple match (without cohort requirement)
  app.post("/api/admin/matches", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { mentorId, menteeId, notes } = req.body;
      
      if (!mentorId || !menteeId) {
        return res.status(400).json({ message: "Mentor and mentee are required" });
      }

      if (mentorId === menteeId) {
        return res.status(400).json({ message: "Cannot match a user with themselves" });
      }

      // Check if mentor exists and has a role that can be a mentor (MENTOR, ADMIN, or SUPER_ADMIN)
      const mentor = await storage.getUser(mentorId);
      if (!mentor) {
        return res.status(404).json({ message: "Mentor not found" });
      }
      if (!['MENTOR', 'ADMIN', 'SUPER_ADMIN'].includes(mentor.role)) {
        return res.status(400).json({ message: "Selected user must have MENTOR, ADMIN, or SUPER_ADMIN role to be a mentor" });
      }

      // Check if mentee exists and is a mentee
      const mentee = await storage.getUser(menteeId);
      if (!mentee) {
        return res.status(404).json({ message: "Mentee not found" });
      }
      if (mentee.role !== 'MENTEE') {
        return res.status(400).json({ message: "Selected user is not a mentee" });
      }

      // Check for existing active match between these users
      const existingMatch = await storage.checkExistingMatch(mentorId, menteeId);
      if (existingMatch) {
        return res.status(400).json({ 
          message: "An active match already exists between this mentor and mentee",
          existingMatch
        });
      }

      const match = await storage.createSimpleMatch(mentorId, menteeId, req.user!.id, notes);
      res.status(201).json(match);
    } catch (error) {
      next(error);
    }
  });

  // Delete a match
  app.delete("/api/admin/matches/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const match = await storage.getMatch(req.params.id);
      if (!match) {
        return res.status(404).json({ message: "Match not found" });
      }

      const deleted = await storage.deleteMatch(req.params.id);
      if (!deleted) {
        return res.status(500).json({ message: "Failed to delete match" });
      }
      
      res.json({ message: "Match deleted successfully" });
    } catch (error) {
      next(error);
    }
  });

  // Get goals for a specific match (mentors can view their mentees' goals)
  app.get("/api/matches/:id/goals", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const matchId = req.params.id;
      
      // Use getMatchWithUsers to get mentor/mentee user IDs
      const match = await storage.getMatchWithUsers(matchId);
      if (!match) {
        return res.status(404).json({ message: "Match not found" });
      }
      
      // Authorization: mentors can only see goals for their own matches
      const isAuthorized = 
        user.role === 'SUPER_ADMIN' || 
        user.role === 'ADMIN' ||
        match.mentorId === user.id ||
        match.menteeId === user.id;
      
      if (!isAuthorized) {
        return res.status(403).json({ message: "Not authorized to view goals for this match" });
      }
      
      // Get goals for this match (goals linked to this match OR owned by the mentee)
      const goals = await storage.getGoals({ 
        matchId: matchId 
      });
      
      // Also get goals owned by the mentee that may not have a matchId set
      const menteeGoals = await storage.getGoals({ 
        ownerId: match.menteeId 
      });
      
      // Combine and deduplicate
      const allGoals = [...goals];
      for (const goal of menteeGoals) {
        if (!allGoals.some(g => g.id === goal.id)) {
          allGoals.push(goal);
        }
      }
      
      res.json(allGoals);
    } catch (error) {
      next(error);
    }
  });

  // Get all mentee goals for a mentor (across all their matches) - ADMIN/SUPER_ADMIN can also be mentors
  app.get("/api/mentor/mentee-goals", requireRole("MENTOR", "ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Get all active matches where this user is the mentor
      const matches = await storage.getMatchesForUser(user.id);
      // Filter to matches where the user is the mentor (mentor.id matches user.id)
      const mentorMatches = matches.filter(m => m.mentor?.id === user.id && m.status === 'ACTIVE');
      
      // Get goals for all mentees
      const allGoals: any[] = [];
      for (const match of mentorMatches) {
        if (match.mentee?.id) {
          const menteeGoals = await storage.getGoals({ ownerId: match.mentee.id });
          allGoals.push(...menteeGoals.map(goal => ({
            ...goal,
            mentee: match.mentee,
            menteeName: `${match.mentee?.firstName || ''} ${match.mentee?.lastName || ''}`.trim(),
            menteeId: match.mentee?.id,
            matchId: match.id
          })));
        }
      }
      
      res.json(allGoals);
    } catch (error) {
      next(error);
    }
  });

  // Get documents shared from a specific mentee to the current mentor
  app.get("/api/mentee/:menteeId/shared-documents", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const menteeId = req.params.menteeId;
      const isAdmin = user.role === "SUPER_ADMIN" || user.role === "ADMIN";
      
      // Verify mentor-mentee relationship exists (only mentors can access, not mentees)
      const matches = await storage.getMatchesForUser(user.id);
      const mentorMatch = matches.find(m => m.mentor?.id === user.id && m.mentee?.id === menteeId);
      
      if (!isAdmin && !mentorMatch) {
        return res.status(403).json({ message: "Not authorized to view documents for this mentee" });
      }
      
      // For mentors: get documents the mentee shared with them
      // For admins: get all documents uploaded by the mentee that have been shared
      if (isAdmin) {
        // Get all documents uploaded by this mentee
        const docs = await storage.getDocuments({ uploadedById: menteeId });
        res.json(docs.map(doc => ({ ...doc, sharedAt: doc.createdAt })));
      } else {
        // Get documents the mentee shared with the current mentor
        const docs = await storage.getDocumentsSharedFromUser(user.id, menteeId);
        res.json(docs);
      }
    } catch (error) {
      next(error);
    }
  });

  // Get mentee profile for mentor view
  app.get("/api/mentee/:menteeId/profile", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const menteeId = req.params.menteeId;
      
      // Verify mentor-mentee relationship exists
      const matches = await storage.getMatchesForUser(user.id);
      const match = matches.find(m => 
        (m.mentor?.id === user.id && m.mentee?.id === menteeId) ||
        (user.role === "SUPER_ADMIN" || user.role === "ADMIN")
      );
      
      if (!match && user.role !== "SUPER_ADMIN" && user.role !== "ADMIN") {
        return res.status(403).json({ message: "Not authorized to view this mentee's profile" });
      }
      
      const mentee = await storage.getUser(menteeId);
      if (!mentee) {
        return res.status(404).json({ message: "Mentee not found" });
      }
      
      // Return public profile fields
      const publicProfile = {
        id: mentee.id,
        firstName: mentee.firstName,
        lastName: mentee.lastName,
        email: mentee.email,
        role: mentee.role,
        profileImage: mentee.profileImage,
        bio: mentee.bio,
        jobTitle: mentee.jobTitle,
        organizationName: mentee.organizationName,
        linkedInUrl: mentee.linkedInUrl,
        phone: mentee.phone,
        timezone: mentee.timezone,
        yearsOfExperience: mentee.yearsOfExperience,
        fieldsOfExpertise: mentee.fieldsOfExpertise,
        educationLevel: mentee.educationLevel,
        certificationsTraining: mentee.certificationsTraining,
        languagesSpoken: mentee.languagesSpoken,
        mentorshipRoleChoice: mentee.mentorshipRoleChoice,
        createdAt: mentee.createdAt,
      };
      
      res.json(publicProfile);
    } catch (error) {
      next(error);
    }
  });

  // Get mentee's goals for mentor view
  app.get("/api/mentee/:menteeId/goals", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const menteeId = req.params.menteeId;
      
      // Verify mentor-mentee relationship exists
      const matches = await storage.getMatchesForUser(user.id);
      const isAuthorized = 
        user.role === "SUPER_ADMIN" || 
        user.role === "ADMIN" ||
        matches.some(m => m.mentor?.id === user.id && m.mentee?.id === menteeId);
      
      if (!isAuthorized) {
        return res.status(403).json({ message: "Not authorized to view goals for this mentee" });
      }
      
      // Get mentee's goals
      const goals = await storage.getGoals({ ownerId: menteeId });
      res.json(goals);
    } catch (error) {
      next(error);
    }
  });

  // Auto-match endpoint (calculates compatibility scores)
  app.post("/api/cohorts/:cohortId/auto-match", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const cohortId = req.params.cohortId;
      const config = await storage.getMatchingConfiguration(cohortId) || {
        languageWeight: 25,
        trackWeight: 20,
        expertiseWeight: 25,
        availabilityWeight: 15,
        experienceWeight: 10,
        communicationWeight: 5,
        minimumScore: 50,
        requireLanguageMatch: true,
        maxMenteesPerMentor: 3,
      };

      const mentors = await storage.getUnmatchedMemberships(cohortId, 'MENTOR');
      const mentees = await storage.getUnmatchedMemberships(cohortId, 'MENTEE');

      // Get responses for all participants
      const mentorData = await Promise.all(mentors.map(async (m) => ({
        ...m,
        responses: await storage.getApplicationResponses(m.id),
      })));

      const menteeData = await Promise.all(mentees.map(async (m) => ({
        ...m,
        responses: await storage.getApplicationResponses(m.id),
      })));

      // Calculate compatibility matrix
      const compatibilityMatrix: Array<{
        mentorId: string;
        menteeId: string;
        score: number;
        breakdown: Record<string, number>;
        flags: string[];
        matchReason: string;
      }> = [];

      for (const mentor of mentorData) {
        for (const mentee of menteeData) {
          const { score, breakdown, flags, matchReason } = calculateCompatibility(
            mentor,
            mentee,
            config
          );
          
          if (score >= (config.minimumScore || 50) || !config.requireLanguageMatch || !flags.includes('no_language_match')) {
            compatibilityMatrix.push({
              mentorId: mentor.id,
              menteeId: mentee.id,
              score,
              breakdown,
              flags,
              matchReason,
            });
          }
        }
      }

      // Sort by score descending
      compatibilityMatrix.sort((a, b) => b.score - a.score);

      res.json({
        mentors: mentorData.map(m => ({ id: m.id, userId: m.userId, user: m.user })),
        mentees: menteeData.map(m => ({ id: m.id, userId: m.userId, user: m.user })),
        compatibilityMatrix,
        config,
      });
    } catch (error) {
      next(error);
    }
  });

  // ============= MESSAGING ROUTES =============

  // Get user's conversations
  app.get("/api/conversations", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const conversations = await storage.getUserConversations(userId);
      
      const sanitizedConversations = conversations.map(conv => ({
        ...conv,
        participants: conv.participants.map(p => ({
          ...p,
          user: { 
            id: p.user.id, 
            firstName: p.user.firstName, 
            lastName: p.user.lastName, 
            profileImage: p.user.profileImage 
          }
        }))
      }));
      
      res.json(sanitizedConversations);
    } catch (error) {
      next(error);
    }
  });

  // Get or create direct conversation with another user
  app.post("/api/conversations/direct", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const { recipientId } = req.body;
      
      if (!recipientId) {
        return res.status(400).json({ message: "Recipient ID is required" });
      }
      
      const conversation = await storage.getOrCreateDirectConversation(userId, recipientId);
      const participants = await storage.getConversationParticipants(conversation.id);
      
      res.json({
        ...conversation,
        participants: participants.map(p => ({
          ...p,
          user: { 
            id: p.user.id, 
            firstName: p.user.firstName, 
            lastName: p.user.lastName, 
            profileImage: p.user.profileImage 
          }
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  // Get single conversation
  app.get("/api/conversations/:id", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const { id } = req.params;
      
      const conversation = await storage.getConversation(id);
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      const participants = await storage.getConversationParticipants(id);
      if (!participants.some(p => p.userId === userId)) {
        return res.status(403).json({ message: "Not authorized to view this conversation" });
      }
      
      res.json({
        ...conversation,
        participants: participants.map(p => ({
          ...p,
          user: { 
            id: p.user.id, 
            firstName: p.user.firstName, 
            lastName: p.user.lastName, 
            profileImage: p.user.profileImage 
          }
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  // Get messages for a conversation
  app.get("/api/conversations/:id/messages", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const { id } = req.params;
      const { limit, before } = req.query;
      
      const participants = await storage.getConversationParticipants(id);
      if (!participants.some(p => p.userId === userId)) {
        return res.status(403).json({ message: "Not authorized to view this conversation" });
      }
      
      const messages = await storage.getMessages(
        id, 
        limit ? parseInt(limit as string) : 50,
        before as string | undefined
      );
      
      res.json(messages.map(m => ({
        ...m,
        sender: { 
          id: m.sender.id, 
          firstName: m.sender.firstName, 
          lastName: m.sender.lastName, 
          profileImage: m.sender.profileImage 
        }
      })));
    } catch (error) {
      next(error);
    }
  });

  // Send a message via REST (fallback if WebSocket not available)
  app.post("/api/conversations/:id/messages", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const { id } = req.params;
      const { content, replyToId } = req.body;
      
      if (!content || !content.trim()) {
        return res.status(400).json({ message: "Message content is required" });
      }
      
      const participants = await storage.getConversationParticipants(id);
      if (!participants.some(p => p.userId === userId)) {
        return res.status(403).json({ message: "Not authorized to send to this conversation" });
      }
      
      const message = await storage.createMessage({
        conversationId: id,
        senderId: userId,
        content: content.trim(),
        messageType: "TEXT",
        replyToId,
      });
      
      const sender = await storage.getUser(userId);
      
      // Send notifications to other participants (for direct messages)
      const conversation = await storage.getConversation(id);
      if (sender && conversation && conversation.type === "DIRECT") {
        const { sendNewMessageEmail, getTrustedBaseUrl } = await import("./email");
        const baseUrl = getTrustedBaseUrl();
        
        for (const participant of participants) {
          if (participant.userId !== userId) {
            const recipient = await storage.getUser(participant.userId);
            if (recipient) {
              // Create in-app notification
              await storage.createNotification({
                userId: participant.userId,
                type: "NEW_MESSAGE",
                title: "New Message",
                message: `${sender.firstName} ${sender.lastName} sent you a message`,
                priority: "NORMAL",
                resourceId: id,
                resourceType: "MESSAGE",
              });
              
              // Send email notification
              await sendNewMessageEmail({
                email: recipient.email,
                recipientName: `${recipient.firstName} ${recipient.lastName}`,
                senderName: `${sender.firstName} ${sender.lastName}`,
                messagePreview: content.trim(),
                timestamp: new Date().toLocaleString(),
                dashboardUrl: baseUrl,
              }).catch((err: Error) => console.error('Failed to send new message email:', err));
            }
          }
        }
      }
      
      const messagePayload = {
        ...message,
        sender: sender ? {
          id: sender.id,
          firstName: sender.firstName,
          lastName: sender.lastName,
          profileImage: sender.profileImage
        } : null,
        attachments: []
      };
      emitMessageNew(id, messagePayload);
      res.status(201).json(messagePayload);
    } catch (error) {
      next(error);
    }
  });

  // Mark messages as read
  app.post("/api/conversations/:id/read", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const { id } = req.params;

      const participants = await storage.getConversationParticipants(id);
      if (!participants.some(p => p.userId === userId)) {
        return res.status(403).json({ message: "Not authorized" });
      }

      await storage.markMessagesAsRead(id, userId);
      emitMessagesRead(id, userId, new Date().toISOString());
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // Delete a message
  app.delete("/api/conversations/:conversationId/messages/:messageId", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const userRole = (req.user as any).role;
      const { conversationId, messageId } = req.params;
      
      const participants = await storage.getConversationParticipants(conversationId);
      if (!participants.some(p => p.userId === userId)) {
        return res.status(403).json({ message: "Not authorized to access this conversation" });
      }
      
      const message = await storage.getMessage(messageId);
      if (!message) {
        return res.status(404).json({ message: "Message not found" });
      }
      
      if (message.conversationId !== conversationId) {
        return res.status(400).json({ message: "Message does not belong to this conversation" });
      }
      
      const isAdmin = userRole === "SUPER_ADMIN" || userRole === "ADMIN";
      if (message.senderId !== userId && !isAdmin) {
        return res.status(403).json({ message: "Not authorized to delete this message" });
      }
      
      await storage.deleteMessage(messageId);
      emitMessageDeleted(conversationId, messageId);
      res.json({ message: "Message deleted" });
    } catch (error) {
      next(error);
    }
  });

  // Ably client token issuance. Client uses authUrl: '/api/ably/auth'
  // when initializing the Realtime SDK; Ably calls this endpoint and
  // passes the returned token request through to the SDK.
  app.post("/api/ably/auth", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const tokenRequest = await issueClientToken(userId);
      if (!tokenRequest) {
        return res.status(503).json({
          message: "Real-time service unavailable (ABLY_API_KEY not configured)",
        });
      }
      res.json(tokenRequest);
    } catch (error) {
      next(error);
    }
  });

  // Online presence is read from Ably on the client (presence:online channel).
  // These endpoints stay as no-ops so older clients keep getting a 200.
  app.get("/api/users/online", requireAuth, async (_req, res, next) => {
    try {
      res.json({ onlineUserIds: getOnlineUsers() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/users/:id/online", requireAuth, async (req, res, next) => {
    try {
      const { id } = req.params;
      res.json({ isOnline: isUserOnline(id) });
    } catch (error) {
      next(error);
    }
  });

  // Create track community conversation (admin only)
  app.post("/api/conversations/community", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const { trackId, cohortId, name } = req.body;
      
      const conversation = await storage.createConversation({
        type: "TRACK_COMMUNITY",
        name,
        trackId,
        cohortId,
        createdById: userId,
      });
      
      res.status(201).json(conversation);
    } catch (error) {
      next(error);
    }
  });

  // Create cohort announcement channel (admin only)
  app.post("/api/conversations/announcement", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const { cohortId, name } = req.body;
      
      const conversation = await storage.createConversation({
        type: "COHORT_ANNOUNCEMENT",
        name: name || "Announcements",
        cohortId,
        createdById: userId,
      });
      
      res.status(201).json(conversation);
    } catch (error) {
      next(error);
    }
  });

  // Direct upload route: client streams the raw file body and we proxy it
  // straight to Vercel Blob via @vercel/blob's put(). Server enforces auth,
  // per-kind size + content-type limits, and the storage path layout.
  //
  // Response: { url, pathname, contentType, size, name } — caller stores
  // `url` in documents.fileUrl or users.profileImage.
  app.post("/api/uploads", requireAuth, uploadRateLimiter, async (req, res, next) => {
    try {
      const kind = (req.query.kind as string | undefined) as UploadKind | undefined;
      const name = req.query.name as string | undefined;

      if (kind !== "document" && kind !== "profile-photo") {
        return res.status(400).json({ message: "Invalid or missing 'kind' query param" });
      }
      if (!name) {
        return res.status(400).json({ message: "Missing 'name' query param" });
      }

      const userId = (req.user as any).id as string;
      const result = await streamRequestToBlob(req, {
        kind,
        userId,
        originalName: name,
      });

      return res.json(result);
    } catch (err) {
      if (err instanceof UploadValidationError) {
        return res.status(400).json({ message: err.message });
      }
      next(err);
    }
  });

  // ============ DOCUMENT MANAGEMENT ROUTES ============

  // Get all documents with filtering
  // Shared document access check — mirrors the visibility filter used by
  // GET /api/documents so that list, single-fetch, view, and download all agree.
  // Without this, scoped (COHORT/TRACK/MATCH) documents appeared in a member's
  // list but returned 403 on open/download.
  async function userCanAccessDocument(
    user: { id: string; role?: string | null },
    doc: { id: string; uploadedById?: string | null; visibility?: string | null; cohortId?: string | null; trackId?: string | null; matchId?: string | null },
  ): Promise<boolean> {
    const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';
    if (isAdmin) return true;
    if (doc.uploadedById === user.id) return true;
    if (doc.visibility === 'PUBLIC') return true;

    // Explicit per-user share access
    const accessRecords = await storage.getDocumentAccess(doc.id);
    if (accessRecords.some(a => a.userId === user.id)) return true;

    if (doc.visibility === 'PRIVATE') return false;

    if (doc.visibility === 'COHORT' || doc.visibility === 'TRACK') {
      const memberships = await db
        .select({ cohortId: cohortMembershipsTable.cohortId, trackId: cohortMembershipsTable.trackId })
        .from(cohortMembershipsTable)
        .where(eq(cohortMembershipsTable.userId, user.id));
      if (doc.visibility === 'COHORT') {
        return !!doc.cohortId && memberships.some(m => m.cohortId === doc.cohortId);
      }
      return !!doc.trackId && memberships.some(m => m.trackId === doc.trackId);
    }

    if (doc.visibility === 'MATCH') {
      if (!doc.matchId) return false;
      const matches = await storage.getMatchesForUser(user.id);
      return matches.some(m => m.id === doc.matchId);
    }

    return false;
  }

  app.get("/api/documents", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { folderId, cohortId, trackId, matchId, visibility, category, isTemplate, search } = req.query;
      const allDocs = await storage.getDocuments({
        folderId: folderId === 'null' ? null : folderId as string | undefined,
        cohortId: cohortId as string | undefined,
        trackId: trackId as string | undefined,
        matchId: matchId as string | undefined,
        visibility: visibility as string | undefined,
        category: category as string | undefined,
        isTemplate: isTemplate === 'true' ? true : isTemplate === 'false' ? false : undefined,
        search: search as string | undefined,
      });
      
      // Filter documents based on user visibility permissions
      const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';

      // Fetch user context once (parallel) to avoid N+1 in the filter below
      const [userAccessDocs, userMemberships, userMatches] = await Promise.all([
        storage.getDocumentAccessByUser(user.id),
        isAdmin ? Promise.resolve([]) : db
          .select({ cohortId: cohortMembershipsTable.cohortId, trackId: cohortMembershipsTable.trackId })
          .from(cohortMembershipsTable)
          .where(eq(cohortMembershipsTable.userId, user.id)),
        isAdmin ? Promise.resolve([]) : storage.getMatchesForUser(user.id),
      ]);

      const accessibleDocIds = new Set(userAccessDocs.map(a => a.documentId));
      const memberCohortIds = new Set(userMemberships.map(m => m.cohortId));
      const memberTrackIds = new Set(userMemberships.map(m => m.trackId).filter(Boolean) as string[]);
      const memberMatchIds = new Set(userMatches.map(m => m.id));

      const filteredDocs = allDocs.filter(doc => {
        // Admins can see all documents
        if (isAdmin) return true;
        // Owner can always see their own documents
        if (doc.uploadedById === user.id) return true;
        // PUBLIC documents visible to everyone
        if (doc.visibility === 'PUBLIC') return true;
        // Check if user has explicit share access
        if (accessibleDocIds.has(doc.id)) return true;
        // PRIVATE only visible to owner (already handled above)
        if (doc.visibility === 'PRIVATE') return false;
        // COHORT-scoped: user must be a member of the document's cohort
        if (doc.visibility === 'COHORT') return doc.cohortId ? memberCohortIds.has(doc.cohortId) : false;
        // TRACK-scoped: user must be a member of the document's track
        if (doc.visibility === 'TRACK') return doc.trackId ? memberTrackIds.has(doc.trackId) : false;
        // MATCH-scoped: user must be a participant in the document's match
        if (doc.visibility === 'MATCH') return doc.matchId ? memberMatchIds.has(doc.matchId) : false;
        return false;
      });
      
      res.json(filteredDocs);
    } catch (error) {
      next(error);
    }
  });

  // Get documents shared with current user — must be before /:id to avoid Express
  // matching the literal string "shared-with-me" as a document ID.
  app.get("/api/documents/shared-with-me", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const sharedDocs = await storage.getSharedDocumentsForUser(userId);
      res.json(sharedDocs);
    } catch (error) {
      next(error);
    }
  });

  // Get single document
  app.get("/api/documents/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const doc = await storage.getDocument(req.params.id);
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      
      if (!(await userCanAccessDocument(user, doc))) {
        return res.status(403).json({ message: "Access denied" });
      }

      res.json(doc);
    } catch (error) {
      next(error);
    }
  });

  // Create document (after file upload)
  app.post("/api/documents", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const validatedData = insertDocumentSchema.parse({
        ...req.body,
        uploadedById: user.id,
      });

      if (validatedData.folderId) {
        const folder = await storage.getFolder(validatedData.folderId);
        if (folder && folder.scope === 'SYSTEM' && user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
          return res.status(403).json({ message: "Only administrators can upload documents to system resource folders" });
        }
      }

      const doc = await storage.createDocument(validatedData);
      
      // Send notifications for PUBLIC visibility documents in system folders
      if (validatedData.visibility === 'PUBLIC' && validatedData.folderId) {
        const folder = await storage.getFolder(validatedData.folderId);
        if (folder && folder.isSystemFolder) {
          const { sendDocumentUploadedEmail, getTrustedBaseUrl } = await import("./email");
          const baseUrl = getTrustedBaseUrl();
          
          // Get all active users
          const allUsers = await storage.getAllUsers({ isActive: true });
          
          // Send notifications to all users except the uploader
          for (const recipient of allUsers) {
            if (recipient.id !== user.id) {
              // Create in-app notification
              await storage.createNotification({
                userId: recipient.id,
                type: "DOCUMENT_SHARED",
                title: "New Resource Available",
                message: `A new document has been uploaded: ${doc.name}`,
                priority: "LOW",
                resourceId: doc.id,
                resourceType: "DOCUMENT",
              });
              
              // Send email notification
              await sendDocumentUploadedEmail({
                email: recipient.email,
                recipientName: `${recipient.firstName} ${recipient.lastName}`,
                documentTitle: doc.name,
                description: doc.description || undefined,
                uploadDate: new Date().toLocaleDateString(),
                uploadedBy: `${user.firstName} ${user.lastName}`,
                dashboardUrl: baseUrl,
              }).catch((err: Error) => console.error('Failed to send document upload email:', err));
            }
          }
        }
      }
      
      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'DOCUMENT_UPLOADED',
        resourceType: 'DOCUMENT',
        resourceId: doc.id,
        resourceName: doc.name,
        metadata: { folderId: doc.folderId, visibility: doc.visibility, mimeType: doc.mimeType },
      });

      res.status(201).json(doc);
    } catch (error) {
      next(error);
    }
  });

  // Update document
  app.patch("/api/documents/:id", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const doc = await storage.getDocument(req.params.id);
      
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      
      // Only owner or admin can update
      if (doc.uploadedById !== userId && !(req.user as any).role.includes("ADMIN")) {
        return res.status(403).json({ message: "Not authorized to update this document" });
      }
      
      const updated = await storage.updateDocument(req.params.id, req.body);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Delete document
  app.delete("/api/documents/:id", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const doc = await storage.getDocument(req.params.id);
      
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      
      // Only owner or admin can delete
      if (doc.uploadedById !== userId && !(req.user as any).role.includes("ADMIN")) {
        return res.status(403).json({ message: "Not authorized to delete this document" });
      }
      
      await storage.deleteDocument(req.params.id);
      res.json({ message: "Document deleted" });
    } catch (error) {
      next(error);
    }
  });

  // View document inline (validates access and streams file for in-browser viewing)
  app.get("/api/documents/:id/view", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const doc = await storage.getDocument(req.params.id);
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      
      if (!(await userCanAccessDocument(user, doc))) {
        return res.status(403).json({ message: "Access denied" });
      }

      try {
        const fileName = doc.name + (doc.mimeType === 'application/pdf' ? '.pdf' : '');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');

        await streamBlobToResponse(doc.fileUrl, res, {
          contentType: doc.mimeType || 'application/octet-stream',
          cacheControl: 'private, max-age=3600',
          contentDisposition: `inline; filename="${encodeURIComponent(fileName)}"`,
        });
      } catch (err) {
        console.error(`[view] Error viewing file: ${doc.fileUrl}`, err);
        if (err instanceof ObjectNotFoundError) {
          return res.status(404).json({
            message: "File not found in storage. The file may pre-date the Vercel Blob migration; please re-upload.",
            fileUrl: doc.fileUrl,
          });
        }
        throw err;
      }
    } catch (error) {
      next(error);
    }
  });

  // Download document (validates access and streams file)
  app.get("/api/documents/:id/download", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const doc = await storage.getDocument(req.params.id);
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }

      if (!(await userCanAccessDocument(user, doc))) {
        return res.status(403).json({ message: "Access denied" });
      }

      try {
        const fileName = doc.name + (doc.mimeType === 'application/pdf' ? '.pdf' : '');
        await storage.incrementDownloadCount(req.params.id);

        await streamBlobToResponse(doc.fileUrl, res, {
          contentType: doc.mimeType || 'application/octet-stream',
          cacheControl: 'private, max-age=3600',
          contentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
        });
      } catch (err) {
        console.error(`[download] Error downloading file: ${doc.fileUrl}`, err);
        if (err instanceof ObjectNotFoundError) {
          return res.status(404).json({ 
            message: "File not found in storage. This may happen if the file was uploaded in a different environment (development vs production). Please re-upload the file.",
            fileUrl: doc.fileUrl
          });
        }
        throw err;
      }
    } catch (error) {
      next(error);
    }
  });
  
  // Legacy POST endpoint for backward compatibility
  app.post("/api/documents/:id/download", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const doc = await storage.getDocument(req.params.id);
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      
      if (!(await userCanAccessDocument(user, doc))) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      await storage.incrementDownloadCount(req.params.id);
      // Return the download URL for the client to use
      res.json({ downloadUrl: `/api/documents/${req.params.id}/download` });
    } catch (error) {
      next(error);
    }
  });

  // Get document versions
  app.get("/api/documents/:id/versions", requireAuth, async (req, res, next) => {
    try {
      const versions = await storage.getDocumentVersions(req.params.id);
      res.json(versions);
    } catch (error) {
      next(error);
    }
  });

  // Create new document version
  app.post("/api/documents/:id/versions", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const doc = await storage.getDocument(req.params.id);
      
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      
      // Create version record
      const version = await storage.createDocumentVersion({
        documentId: req.params.id,
        version: (doc.version || 1) + 1,
        fileUrl: req.body.fileUrl,
        fileSize: req.body.fileSize,
        uploadedById: userId,
        changeNotes: req.body.changeNotes,
      });
      
      // Update document with new version
      await storage.updateDocument(req.params.id, {
        fileUrl: req.body.fileUrl,
        fileSize: req.body.fileSize,
        version: version.version,
      });
      
      res.status(201).json(version);
    } catch (error) {
      next(error);
    }
  });

  // ============ FOLDER ROUTES ============

  // Get all folders
  app.get("/api/folders", requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const { parentFolderId, cohortId, trackId, matchId, visibility } = req.query;
      const allFolders = await storage.getFolders({
        parentFolderId: parentFolderId === 'null' ? null : parentFolderId as string | undefined,
        cohortId: cohortId as string | undefined,
        trackId: trackId as string | undefined,
        matchId: matchId as string | undefined,
        visibility: visibility as string | undefined,
      });
      
      // Filter folders based on user visibility permissions
      const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';
      const filteredFolders = allFolders.filter(folder => {
        if (isAdmin) return true;
        if (folder.ownerId === user.id) return true;
        if (folder.visibility === 'PUBLIC') return true;
        if (folder.visibility === 'PRIVATE') return false;
        // TODO: Implement cohort/track/match membership checking
        return false;
      });
      
      res.json(filteredFolders);
    } catch (error) {
      next(error);
    }
  });

  // Get or create system folder (public resources)
  // NOTE: This must come BEFORE /api/folders/:id to avoid matching "system" as an id
  app.get("/api/folders/system", requireAuth, async (req, res, next) => {
    try {
      const folder = await storage.getOrCreateSystemFolder();
      res.json(folder);
    } catch (error) {
      next(error);
    }
  });

  // Get or create personal folder for current user
  // NOTE: This must come BEFORE /api/folders/:id to avoid matching "personal" as an id
  app.get("/api/folders/personal", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const folder = await storage.getOrCreatePersonalFolder(userId);
      res.json(folder);
    } catch (error) {
      next(error);
    }
  });

  // Get single folder
  app.get("/api/folders/:id", requireAuth, async (req, res, next) => {
    try {
      const folder = await storage.getFolder(req.params.id);
      if (!folder) {
        return res.status(404).json({ message: "Folder not found" });
      }
      res.json(folder);
    } catch (error) {
      next(error);
    }
  });

  // Create folder
  app.post("/api/folders", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const validatedData = insertFolderSchema.parse({
        ...req.body,
        ownerId: user.id,
      });

      // Restrict folder creation in system resource folders to admins only
      if (validatedData.parentFolderId) {
        const parentFolder = await storage.getFolder(validatedData.parentFolderId);
        if (parentFolder && parentFolder.scope === 'SYSTEM' && user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
          return res.status(403).json({ message: "Only administrators can create folders in system resource areas" });
        }
      }
      if (validatedData.scope === 'SYSTEM' && user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
        return res.status(403).json({ message: "Only administrators can create system folders" });
      }

      const folder = await storage.createFolder(validatedData);
      res.status(201).json(folder);
    } catch (error) {
      next(error);
    }
  });

  // Update folder
  app.patch("/api/folders/:id", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const folder = await storage.getFolder(req.params.id);
      
      if (!folder) {
        return res.status(404).json({ message: "Folder not found" });
      }
      
      if (folder.ownerId !== userId && !(req.user as any).role.includes("ADMIN")) {
        return res.status(403).json({ message: "Not authorized to update this folder" });
      }
      
      const updated = await storage.updateFolder(req.params.id, req.body);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Delete folder
  app.delete("/api/folders/:id", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const folder = await storage.getFolder(req.params.id);
      
      if (!folder) {
        return res.status(404).json({ message: "Folder not found" });
      }
      
      if (folder.ownerId !== userId && !(req.user as any).role.includes("ADMIN")) {
        return res.status(403).json({ message: "Not authorized to delete this folder" });
      }
      
      await storage.deleteFolder(req.params.id);
      res.json({ message: "Folder deleted" });
    } catch (error) {
      next(error);
    }
  });

  // ============ DOCUMENT ACCESS/SHARING ROUTES ============

  // Get document access list
  app.get("/api/documents/:id/access", requireAuth, async (req, res, next) => {
    try {
      const accessList = await storage.getDocumentAccess(req.params.id);
      res.json(accessList);
    } catch (error) {
      next(error);
    }
  });

  // Grant document access
  app.post("/api/documents/:id/access", requireAuth, async (req, res, next) => {
    try {
      const userId = (req.user as any).id;
      const doc = await storage.getDocument(req.params.id);
      
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      
      if (doc.uploadedById !== userId && !(req.user as any).role.includes("ADMIN")) {
        return res.status(403).json({ message: "Not authorized to share this document" });
      }
      
      const validatedData = insertDocumentAccessSchema.parse({
        documentId: req.params.id,
        userId: req.body.userId,
        accessType: req.body.accessType || "VIEW",
        grantedById: userId,
        expiresAt: req.body.expiresAt,
      });
      
      const access = await storage.grantDocumentAccess(validatedData);
      res.status(201).json(access);
    } catch (error) {
      next(error);
    }
  });

  // Revoke document access
  app.delete("/api/documents/:id/access/:userId", requireAuth, async (req, res, next) => {
    try {
      const currentUserId = (req.user as any).id;
      const doc = await storage.getDocument(req.params.id);
      
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      
      if (doc.uploadedById !== currentUserId && !(req.user as any).role.includes("ADMIN")) {
        return res.status(403).json({ message: "Not authorized to manage access for this document" });
      }
      
      await storage.revokeDocumentAccess(req.params.id, req.params.userId);
      res.json({ message: "Access revoked" });
    } catch (error) {
      next(error);
    }
  });

  // Admin: Get all documents for management
  app.get("/api/admin/documents", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { category, visibility, search } = req.query;
      const docs = await storage.getDocuments({
        category: category as string | undefined,
        visibility: visibility as string | undefined,
        search: search as string | undefined,
      });
      res.json(docs);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Get all folders for management
  app.get("/api/admin/folders", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const folderList = await storage.getFolders({});
      res.json(folderList);
    } catch (error) {
      next(error);
    }
  });

  // Share document with another user (with notification)
  app.post("/api/documents/:id/share", requireAuth, async (req, res, next) => {
    try {
      const currentUserId = (req.user as any).id;
      const currentUser = req.user as any;
      const userRole = currentUser?.role || "";
      const isAdmin = userRole === "ADMIN" || userRole === "SUPER_ADMIN";
      
      const doc = await storage.getDocument(req.params.id);
      
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      
      // Check folder scope for SYSTEM documents - only admins can share
      if (doc.folderId) {
        const folder = await storage.getFolder(doc.folderId);
        if (folder?.scope === "SYSTEM" && !isAdmin) {
          return res.status(403).json({ message: "Only administrators can share system documents" });
        }
      }
      
      // Only owner or admin can share personal documents
      if (doc.uploadedById !== currentUserId && !isAdmin) {
        return res.status(403).json({ message: "Not authorized to share this document" });
      }
      
      // Validate request body
      const { userId, message } = req.body;
      
      if (!userId || typeof userId !== "string") {
        return res.status(400).json({ message: "Valid user ID is required" });
      }
      
      if (message !== undefined && typeof message !== "string") {
        return res.status(400).json({ message: "Message must be a string" });
      }
      
      const access = await storage.grantDocumentAccess({
        documentId: req.params.id,
        userId,
        accessType: "VIEW",
        grantedById: currentUserId,
      });
      
      await storage.createNotification({
        userId,
        type: "DOCUMENT_SHARED",
        title: "Document Shared",
        message: `${currentUser.firstName} ${currentUser.lastName} shared a document with you: ${doc.name}${message ? ` - "${message}"` : ""}`,
        priority: "NORMAL",
        resourceType: "DOCUMENT",
        resourceId: doc.id,
        data: { documentId: doc.id, sharedById: currentUserId, message: message || null },
      });
      
      res.status(201).json({ success: true, access });
    } catch (error) {
      next(error);
    }
  });

  // Share document with multiple users at once
  app.post("/api/documents/:id/share-bulk", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const currentUser = req.user as any;
      const doc = await storage.getDocument(req.params.id);

      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }

      const { userIds, message } = req.body;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ message: "At least one user ID is required" });
      }

      const results: { userId: string; success: boolean; error?: string }[] = [];

      for (const userId of userIds) {
        try {
          await storage.grantDocumentAccess({
            documentId: req.params.id,
            userId,
            accessType: "VIEW",
            grantedById: currentUser.id,
          });

          await storage.createNotification({
            userId,
            type: "DOCUMENT_SHARED",
            title: "Document Shared",
            message: `${currentUser.firstName} ${currentUser.lastName} shared a document with you: ${doc.name}${message ? ` - "${message}"` : ""}`,
            priority: "NORMAL",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            data: { documentId: doc.id, sharedById: currentUser.id, message: message || null },
          });

          results.push({ userId, success: true });
        } catch (err: any) {
          results.push({ userId, success: false, error: err.message });
        }
      }

      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'DOCUMENT_SHARED',
        resourceType: 'DOCUMENT',
        resourceId: doc.id,
        resourceName: doc.name,
        metadata: { recipientCount: userIds.length, message },
      });

      res.status(201).json({
        success: true,
        sharedCount: results.filter(r => r.success).length,
        totalRequested: userIds.length,
        results,
      });
    } catch (error) {
      next(error);
    }
  });

  // ============= GOAL MANAGEMENT ROUTES =============

  // Get goals with filtering
  app.get("/api/goals", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const { matchId, trackId, status, category, mentorApproved, search } = req.query;
      
      const filters: any = {
        matchId: matchId as string | undefined,
        trackId: trackId as string | undefined,
        status: status as string | undefined,
        category: category as string | undefined,
        mentorApproved: mentorApproved === 'true' ? true : mentorApproved === 'false' ? false : undefined,
        search: search as string | undefined,
      };
      
      // For non-admins, restrict to their own goals
      if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
        filters.ownerId = user.id;
      }
      
      const goalList = await storage.getGoals(filters);
      res.json(goalList);
    } catch (error) {
      next(error);
    }
  });

  // Get single goal with milestones
  app.get("/api/goals/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const goal = await storage.getGoal(req.params.id);
      
      if (!goal) {
        return res.status(404).json({ message: "Goal not found" });
      }
      
      // Authorization check
      const isAuthorized = goal.ownerId === user.id || 
                          goal.createdById === user.id || 
                          user.role === 'SUPER_ADMIN' || 
                          user.role === 'ADMIN' ||
                          user.role === 'MENTOR'; // Mentors can view mentee goals
      
      if (!isAuthorized) {
        return res.status(403).json({ message: "Not authorized to view this goal" });
      }
      
      // Include milestones and progress history
      const milestoneList = await storage.getMilestones(goal.id);
      const progressHistory = await storage.getGoalProgressHistory(goal.id);
      
      res.json({ ...goal, milestones: milestoneList, progressHistory });
    } catch (error) {
      next(error);
    }
  });

  // Create goal
  app.post("/api/goals", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Preprocess data to convert empty strings to undefined and date strings to Date objects
      const processedData: Record<string, any> = {};
      const dateFields = ['targetDate', 'completedAt'];
      for (const [key, value] of Object.entries(req.body)) {
        if (value === '' || value === null) {
          processedData[key] = undefined;
        } else if (dateFields.includes(key) && typeof value === 'string') {
          processedData[key] = new Date(value);
        } else {
          processedData[key] = value;
        }
      }
      
      const validatedData = insertGoalSchema.parse({
        ...processedData,
        createdById: user.id,
        ownerId: processedData.ownerId || user.id,
        mentorApproved: user.role === 'MENTOR', // Auto-approve if mentor creates it
      });
      
      const goal = await storage.createGoal(validatedData);
      
      // Notify mentor when mentee creates a new goal (via matchId)
      if (user.role === 'MENTEE' && goal.matchId) {
        const matchWithUsers = await storage.getMatchWithUsers(goal.matchId);
        if (matchWithUsers && matchWithUsers.mentorId && matchWithUsers.mentorId !== user.id) {
          const mentor = matchWithUsers.mentor;
          if (mentor) {
            const { sendGoalUpdateEmail, getTrustedBaseUrl } = await import("./email");
            const baseUrl = getTrustedBaseUrl();
            
            // Create in-app notification
            await storage.createNotification({
              userId: mentor.id,
              type: "GOAL_FEEDBACK",
              title: "New Goal Created",
              message: `${user.firstName} ${user.lastName} created a new goal: ${goal.title}`,
              priority: "NORMAL",
              resourceId: goal.id,
              resourceType: "GOAL",
            });
            
            // Send email notification
            await sendGoalUpdateEmail({
              email: mentor.email,
              recipientName: `${mentor.firstName} ${mentor.lastName}`,
              goalTitle: goal.title,
              updateType: 'new_goal',
              preview: goal.description || undefined,
              updatedBy: `${user.firstName} ${user.lastName}`,
              dashboardUrl: baseUrl,
            }).catch((err: Error) => console.error('Failed to send goal update email:', err));
          }
        }
      }
      
      res.status(201).json(goal);
    } catch (error) {
      next(error);
    }
  });

  // Update goal
  app.patch("/api/goals/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const goal = await storage.getGoal(req.params.id);
      
      if (!goal) {
        return res.status(404).json({ message: "Goal not found" });
      }
      
      // Authorization check
      const isOwner = goal.ownerId === user.id;
      const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';
      const isMentor = user.role === 'MENTOR';
      
      if (!isOwner && !isAdmin && !isMentor) {
        return res.status(403).json({ message: "Not authorized to update this goal" });
      }
      
      // Preprocess data to convert date strings to Date objects
      const processedData: Record<string, any> = {};
      const dateFields = ['targetDate', 'completedAt'];
      for (const [key, value] of Object.entries(req.body)) {
        if (value === '' || value === null) {
          processedData[key] = null;
        } else if (dateFields.includes(key) && typeof value === 'string') {
          processedData[key] = new Date(value);
        } else {
          processedData[key] = value;
        }
      }
      
      // Track progress changes
      if (processedData.progress !== undefined && processedData.progress !== goal.progress) {
        await storage.createGoalProgress({
          goalId: goal.id,
          previousProgress: goal.progress || 0,
          newProgress: processedData.progress,
          notes: processedData.progressNotes || null,
          updatedById: user.id,
        });
      }
      
      const updatedGoal = await storage.updateGoal(req.params.id, processedData);
      res.json(updatedGoal);
    } catch (error) {
      next(error);
    }
  });

  // Mentor approve goal
  app.post("/api/goals/:id/approve", requireRole("MENTOR", "ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
    try {
      const user = req.user as any;
      const goal = await storage.getGoal(req.params.id);
      
      if (!goal) {
        return res.status(404).json({ message: "Goal not found" });
      }
      
      const updatedGoal = await storage.updateGoal(req.params.id, {
        mentorApproved: true,
        mentorFeedback: req.body.feedback || null,
      });
      
      // Notify goal owner about mentor feedback/approval
      if (goal.ownerId && goal.ownerId !== user.id) {
        const owner = await storage.getUser(goal.ownerId);
        if (owner) {
          const { sendGoalUpdateEmail, getTrustedBaseUrl } = await import("./email");
          const baseUrl = getTrustedBaseUrl();
          
          // Create in-app notification
          await storage.createNotification({
            userId: owner.id,
            type: "GOAL_APPROVED",
            title: "Goal Approved",
            message: `${user.firstName} ${user.lastName} approved your goal: ${goal.title}`,
            priority: "NORMAL",
            resourceId: goal.id,
            resourceType: "GOAL",
          });
          
          // Send email notification
          await sendGoalUpdateEmail({
            email: owner.email,
            recipientName: `${owner.firstName} ${owner.lastName}`,
            goalTitle: goal.title,
            updateType: req.body.feedback ? 'new_comment' : 'goal_modified',
            preview: req.body.feedback || 'Your goal has been approved by your mentor.',
            updatedBy: `${user.firstName} ${user.lastName}`,
            dashboardUrl: baseUrl,
          }).catch((err: Error) => console.error('Failed to send goal approval email:', err));
        }
      }
      
      res.json(updatedGoal);
    } catch (error) {
      next(error);
    }
  });

  // Delete goal
  app.delete("/api/goals/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const goal = await storage.getGoal(req.params.id);
      
      if (!goal) {
        return res.status(404).json({ message: "Goal not found" });
      }
      
      // Only creator, owner, or admin can delete
      const isAuthorized = goal.createdById === user.id || 
                          goal.ownerId === user.id ||
                          user.role === 'SUPER_ADMIN' || 
                          user.role === 'ADMIN';
      
      if (!isAuthorized) {
        return res.status(403).json({ message: "Not authorized to delete this goal" });
      }
      
      await storage.deleteGoal(req.params.id);
      res.json({ message: "Goal deleted" });
    } catch (error) {
      next(error);
    }
  });

  // Milestone CRUD
  app.get("/api/goals/:id/milestones", requireAuth, async (req, res, next) => {
    try {
      const milestoneList = await storage.getMilestones(req.params.id);
      res.json(milestoneList);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/goals/:id/milestones", requireAuth, async (req, res, next) => {
    try {
      const validatedData = insertMilestoneSchema.parse({
        ...req.body,
        goalId: req.params.id,
      });
      
      const milestone = await storage.createMilestone(validatedData);
      res.status(201).json(milestone);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/milestones/:id", requireAuth, async (req, res, next) => {
    try {
      const updatedMilestone = await storage.updateMilestone(req.params.id, req.body);
      
      if (!updatedMilestone) {
        return res.status(404).json({ message: "Milestone not found" });
      }
      
      res.json(updatedMilestone);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/milestones/:id", requireAuth, async (req, res, next) => {
    try {
      await storage.deleteMilestone(req.params.id);
      res.json({ message: "Milestone deleted" });
    } catch (error) {
      next(error);
    }
  });

  // Goal progress history
  app.get("/api/goals/:id/progress", requireAuth, async (req, res, next) => {
    try {
      const progressHistory = await storage.getGoalProgressHistory(req.params.id);
      res.json(progressHistory);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/goals/:id/progress", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const goal = await storage.getGoal(req.params.id);
      
      if (!goal) {
        return res.status(404).json({ message: "Goal not found" });
      }
      
      const validatedData = insertGoalProgressSchema.parse({
        goalId: req.params.id,
        previousProgress: goal.progress || 0,
        newProgress: req.body.newProgress,
        notes: req.body.notes,
        updatedById: user.id,
      });
      
      const progressRecord = await storage.createGoalProgress(validatedData);
      
      // Update goal's progress
      await storage.updateGoal(req.params.id, { progress: req.body.newProgress });
      
      res.status(201).json(progressRecord);
    } catch (error) {
      next(error);
    }
  });

  // Meeting Routes
  app.get("/api/meetings", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const meetings = await storage.getMeetingsForUser(user.id);
      res.json(meetings);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/meetings", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const meetings = await storage.getAllMeetingsWithDetails();
      res.json(meetings);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/meetings/:id", requireAuth, async (req, res, next) => {
    try {
      const meeting = await storage.getMeeting(req.params.id);
      if (!meeting) {
        return res.status(404).json({ message: "Meeting not found" });
      }
      res.json(meeting);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/meetings", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const validatedData = insertMeetingLogSchema.parse({
        ...req.body,
        createdById: user.id,
      });
      
      const meeting = await storage.createMeeting(validatedData);
      res.status(201).json(meeting);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/meetings/:id", requireAuth, async (req, res, next) => {
    try {
      const meeting = await storage.getMeeting(req.params.id);
      if (!meeting) {
        return res.status(404).json({ message: "Meeting not found" });
      }

      const updated = await storage.updateMeeting(req.params.id, req.body);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Post-meeting feedback — the mentor or mentee rates a session they were
  // part of. submitSessionFeedback returns null when the caller isn't in the
  // match, which is the 403 signal.
  app.post("/api/meetings/:id/feedback", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const input = sessionFeedbackInputSchema.parse(req.body);
      const result = await storage.submitSessionFeedback(req.params.id, user.id, input);
      if (!result) {
        return res.status(403).json({ message: "You can only give feedback on your own meetings." });
      }
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid feedback", errors: error.errors });
      }
      next(error);
    }
  });

  // Both sides' feedback for a meeting. Participants and admins only.
  app.get("/api/meetings/:id/feedback", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const meeting = await storage.getMeeting(req.params.id);
      if (!meeting) {
        return res.status(404).json({ message: "Meeting not found" });
      }
      const isAdmin = user.role === "ADMIN" || user.role === "SUPER_ADMIN";
      if (!isAdmin) {
        const match = await storage.getMatchWithUsers(meeting.matchId);
        if (!match || (match.mentorId !== user.id && match.menteeId !== user.id)) {
          return res.status(403).json({ message: "Not your meeting." });
        }
      }
      const feedback = await storage.getSessionFeedback(req.params.id);
      res.json(feedback);
    } catch (error) {
      next(error);
    }
  });

  // Program-wide session-feedback rollup for admins.
  app.get("/api/admin/session-feedback/summary", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const summary = await storage.getSessionFeedbackSummary();
      res.json(summary);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/meetings/:id", requireAuth, async (req, res, next) => {
    try {
      const meeting = await storage.getMeeting(req.params.id);
      if (!meeting) {
        return res.status(404).json({ message: "Meeting not found" });
      }
      
      await storage.deleteMeeting(req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // Calendar Events Routes
  app.get("/api/calendar-events", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const events = await storage.getCalendarEventsForUser(user.id);
      
      const eventsWithParticipants = await Promise.all(events.map(async (event) => {
        const participants = await storage.getCalendarEventParticipants(event.id);
        return {
          ...event,
          participantIds: participants.map(p => p.userId),
        };
      }));
      
      res.json(eventsWithParticipants);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/calendar-events/:id", requireAuth, async (req, res, next) => {
    try {
      const event = await storage.getCalendarEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      
      const participants = await storage.getCalendarEventParticipants(req.params.id);
      res.json({ ...event, participants });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/calendar-events", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const { participantIds, type, title, description, startTime, endTime, location, meetingUrl, format, matchId } = req.body;
      
      if (!type || !title || !startTime || !endTime) {
        return res.status(400).json({ message: "Missing required fields: type, title, startTime, endTime" });
      }
      
      if (type !== "MEETING" && type !== "BLOCK") {
        return res.status(400).json({ message: "Invalid event type. Must be MEETING or BLOCK" });
      }
      
      const start = new Date(startTime);
      const end = new Date(endTime);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ message: "Invalid date format for startTime or endTime" });
      }
      
      if (end <= start) {
        return res.status(400).json({ message: "End time must be after start time" });
      }
      
      let validParticipantIds: string[] = [user.id];
      if (type === "MEETING" && participantIds && Array.isArray(participantIds)) {
        const activeUsers = await storage.getAllUsers({ isActive: true });
        const activeUserIds = new Set(activeUsers.map(u => u.id));
        validParticipantIds = [user.id, ...participantIds.filter((id: string) => activeUserIds.has(id) && id !== user.id)];
      }
      
      const event = await storage.createCalendarEvent({
        type,
        title,
        description: description || undefined,
        startTime: start,
        endTime: end,
        location: location || undefined,
        meetingUrl: meetingUrl || undefined,
        format: format || undefined,
        matchId: matchId || undefined,
        createdById: user.id,
      }, validParticipantIds);
      
      // Send notifications to all participants (except creator) for meetings
      if (type === "MEETING" && validParticipantIds.length > 1) {
        const { sendCalendarInviteEmail, getTrustedBaseUrl } = await import("./email");
        const baseUrl = getTrustedBaseUrl();
        
        const duration = Math.round((end.getTime() - start.getTime()) / (1000 * 60));
        const durationStr = duration >= 60 ? `${Math.floor(duration / 60)}h ${duration % 60}m` : `${duration} minutes`;
        const dateTimeStr = start.toLocaleString('en-US', { 
          weekday: 'long', 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short'
        });
        
        for (const participantId of validParticipantIds) {
          if (participantId !== user.id) {
            const participant = await storage.getUser(participantId);
            if (participant) {
              // Create in-app notification
              await storage.createNotification({
                userId: participantId,
                type: "MEETING_SCHEDULED",
                title: "Meeting Scheduled",
                message: `${user.firstName} ${user.lastName} scheduled a meeting: ${title} on ${start.toLocaleDateString()}`,
                priority: "NORMAL",
                resourceId: event.id,
                resourceType: "MEETING",
              });
              
              // Send email notification
              await sendCalendarInviteEmail({
                email: participant.email,
                recipientName: `${participant.firstName} ${participant.lastName}`,
                eventTitle: title,
                dateTime: dateTimeStr,
                duration: durationStr,
                organizerName: `${user.firstName} ${user.lastName}`,
                description: description || undefined,
                meetingLink: meetingUrl || undefined,
                dashboardUrl: baseUrl,
              }).catch((err: Error) => console.error('Failed to send calendar invite email:', err));
            }
          }
        }
      }
      
      res.status(201).json(event);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/calendar-events/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const event = await storage.getCalendarEvent(req.params.id);
      
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      
      if (event.createdById !== user.id) {
        return res.status(403).json({ message: "Not authorized to update this event" });
      }
      
      const { title, description, startTime, endTime, location, meetingUrl, format, status, participantIds } = req.body;
      
      const updateData: any = {};
      if (title) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (startTime) updateData.startTime = new Date(startTime);
      if (endTime) updateData.endTime = new Date(endTime);
      if (location !== undefined) updateData.location = location;
      if (meetingUrl !== undefined) updateData.meetingUrl = meetingUrl;
      if (format) updateData.format = format;
      if (status) updateData.status = status;
      
      const updated = await storage.updateCalendarEvent(req.params.id, updateData);
      
      if (participantIds && Array.isArray(participantIds) && event.type === "MEETING") {
        await storage.updateCalendarEventParticipants(req.params.id, participantIds, user.id);
      }
      
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/calendar-events/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const event = await storage.getCalendarEvent(req.params.id);
      
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      
      const isAdmin = user.role === "SUPER_ADMIN" || user.role === "ADMIN";
      if (event.createdById !== user.id && !isAdmin) {
        return res.status(403).json({ message: "Not authorized to delete this event" });
      }
      
      await storage.deleteCalendarEvent(req.params.id);
      res.json({ message: "Event deleted" });
    } catch (error) {
      next(error);
    }
  });

  // ── ICS Calendar Feed (#30) ─────────────────────────────────────────────────
  // Public (no session auth) — secured by a per-user opaque token.
  // Calendar apps subscribe via webcal://… or https://… — they can't carry
  // session cookies, so the token is the only security boundary here.

  // GET /api/ics/:token  — returns an iCalendar (.ics) feed for the user
  // whose icsToken matches. Only MEETING events are included; BLOCK events
  // are personal internal markers and don't need to appear in external clients.
  app.get("/api/ics/:token", async (req, res, next) => {
    try {
      const [targetUser] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.icsToken, req.params.token))
        .limit(1);

      if (!targetUser) {
        return res.status(404).send("Calendar feed not found");
      }

      const events = await storage.getCalendarEventsForUser(targetUser.id);

      const calendar = ical({
        name: `SONSIEL – ${targetUser.firstName} ${targetUser.lastName}`,
        prodId: { company: "SONSIEL", product: "Mentorship Platform" },
      });

      for (const ev of events) {
        if (ev.type !== "MEETING") continue;
        if (ev.status === "CANCELLED") continue;

        const start = new Date(ev.startTime);
        // Fall back to 1-hour duration when endTime is absent
        const end = ev.endTime ? new Date(ev.endTime) : new Date(start.getTime() + 60 * 60 * 1000);

        calendar.createEvent({
          id: ev.id,
          start,
          end,
          summary: ev.title,
          description: ev.description ?? undefined,
          location: ev.location ?? undefined,
          url: ev.meetingUrl ?? undefined,
          status: ICalEventStatus.CONFIRMED,
        });
      }

      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", 'inline; filename="sonsiel-calendar.ics"');
      res.send(calendar.toString());
    } catch (error) {
      next(error);
    }
  });

  // POST /api/users/ics-token  — (re)generates the authenticated user's ICS token
  app.post("/api/users/ics-token", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const token = randomUUID();
      await storage.updateUser(user.id, { icsToken: token } as any);
      res.json({ token });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/users/ics-token  — returns the current token (null if not yet generated)
  app.get("/api/users/ics-token", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const [row] = await db
        .select({ icsToken: usersTable.icsToken })
        .from(usersTable)
        .where(eq(usersTable.id, user.id))
        .limit(1);
      res.json({ token: row?.icsToken ?? null });
    } catch (error) {
      next(error);
    }
  });

  // Notification Routes
  app.get("/api/notifications", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const { isRead, isArchived, type, limit, offset } = req.query;
      
      const notifications = await storage.getNotifications(user.id, {
        isRead: isRead === 'true' ? true : isRead === 'false' ? false : undefined,
        isArchived: isArchived === 'true' ? true : isArchived === 'false' ? false : undefined,
        type: type as string | undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
      });
      
      res.json(notifications);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/notifications/unread-count", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const count = await storage.getUnreadNotificationCount(user.id);
      res.json({ count });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/notifications/:id/read", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const notification = await storage.getNotification(req.params.id);
      
      if (!notification || notification.userId !== user.id) {
        return res.status(404).json({ message: "Notification not found" });
      }
      
      const updated = await storage.markNotificationRead(req.params.id);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/notifications/read-all", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      await storage.markAllNotificationsRead(user.id);
      res.json({ message: "All notifications marked as read" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/notifications/:id/archive", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const notification = await storage.getNotification(req.params.id);
      
      if (!notification || notification.userId !== user.id) {
        return res.status(404).json({ message: "Notification not found" });
      }
      
      const updated = await storage.archiveNotification(req.params.id);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/notifications/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const notification = await storage.getNotification(req.params.id);
      
      if (!notification || notification.userId !== user.id) {
        return res.status(404).json({ message: "Notification not found" });
      }
      
      await storage.deleteNotification(req.params.id);
      res.json({ message: "Notification deleted" });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/notifications", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      await storage.deleteAllNotifications(user.id);
      res.json({ message: "All notifications cleared" });
    } catch (error) {
      next(error);
    }
  });

  // Notification Preferences
  app.get("/api/notification-preferences", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const preferences = await storage.getNotificationPreferences(user.id);
      res.json(preferences);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/notification-preferences", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const validatedData = insertNotificationPreferenceSchema.parse({
        ...req.body,
        userId: user.id,
      });
      
      const preference = await storage.upsertNotificationPreference(validatedData);
      res.json(preference);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Create notifications for users (system announcements, etc.)
  app.post("/api/admin/notifications", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const user = req.user as any;
      const { userIds, ...notificationData } = req.body;
      
      if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ message: "userIds array is required" });
      }
      
      const notificationsToCreate = userIds.map((userId: string) => ({
        ...notificationData,
        userId,
      }));
      
      const created = await storage.createManyNotifications(notificationsToCreate);
      
      // Emit real-time notifications to each user
      for (const notification of created) {
        emitNotification(notification.userId, notification);
        const count = await storage.getUnreadNotificationCount(notification.userId);
        emitNotificationCountUpdate(notification.userId, count);
      }
      
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  // Analytics API routes
  app.get("/api/analytics/dashboard", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const dashboard = await storage.getAnalyticsDashboard();
      res.json(dashboard);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analytics/trends", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const trends = await storage.getAnalyticsTrends(days);
      res.json(trends);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analytics/tracks", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const trackAnalytics = await storage.getTrackAnalytics();
      res.json(trackAnalytics);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analytics/cohorts", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const cohortId = req.query.cohortId as string | undefined;
      const cohortAnalytics = await storage.getCohortAnalytics(cohortId);
      res.json(cohortAnalytics);
    } catch (error) {
      next(error);
    }
  });

  // Audit Log API routes
  app.get("/api/audit-logs", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { actorId, action, resourceType, resourceId, success, startDate, endDate, search, limit, offset } = req.query;
      
      const filters = {
        actorId: actorId as string | undefined,
        action: action as string | undefined,
        resourceType: resourceType as string | undefined,
        resourceId: resourceId as string | undefined,
        success: success === 'true' ? true : success === 'false' ? false : undefined,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        search: search as string | undefined,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      };
      
      const [logs, totalCount] = await Promise.all([
        storage.getAuditLogs(filters),
        storage.getAuditLogsCount(filters),
      ]);
      
      res.json({ logs, totalCount, limit: filters.limit, offset: filters.offset });
    } catch (error) {
      next(error);
    }
  });

  // Error Log API routes
  app.get("/api/error-logs", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { resolved, errorType, userId, limit, offset } = req.query;
      
      const filters = {
        resolved: resolved === 'true' ? true : resolved === 'false' ? false : undefined,
        errorType: errorType as string | undefined,
        userId: userId as string | undefined,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      };
      
      const [logs, totalCount] = await Promise.all([
        storage.getErrorLogs(filters),
        storage.getErrorLogsCount(filters),
      ]);
      
      res.json({ logs, totalCount, limit: filters.limit, offset: filters.offset });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/error-logs/:id/resolve", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const resolvedLog = await storage.resolveErrorLog(id, req.user!.id);
      
      if (!resolvedLog) {
        return res.status(404).json({ message: "Error log not found" });
      }
      
      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'SETTINGS_CHANGED',
        resourceType: 'SYSTEM',
        resourceId: id,
        resourceName: 'Error Log Resolution',
        metadata: { errorLogId: id },
      });
      
      res.json(resolvedLog);
    } catch (error) {
      next(error);
    }
  });

  // GDPR Data Export API routes
  app.post("/api/data-export", requireAuth, async (req, res, next) => {
    try {
      const existingRequests = await storage.getDataExportRequestsByUser(req.user!.id);
      const pendingRequest = existingRequests.find(r => r.status === 'PENDING' || r.status === 'PROCESSING');
      
      if (pendingRequest) {
        return res.status(400).json({ message: "You already have a pending export request" });
      }
      
      const exportRequest = await storage.createDataExportRequest({
        userId: req.user!.id,
        status: 'PENDING',
      });
      
      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'DATA_EXPORTED',
        resourceType: 'USER',
        resourceId: req.user!.id,
        resourceName: 'Data Export Request',
      });
      
      res.status(201).json(exportRequest);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/data-export", requireAuth, async (req, res, next) => {
    try {
      const requests = await storage.getDataExportRequestsByUser(req.user!.id);
      res.json(requests);
    } catch (error) {
      next(error);
    }
  });

  // GDPR Account Deletion API routes
  app.post("/api/account-deletion", requireAuth, async (req, res, next) => {
    try {
      const { reason } = req.body;
      
      const existingRequests = await storage.getAccountDeletionRequestsByUser(req.user!.id);
      const pendingRequest = existingRequests.find(r => r.status === 'PENDING' || r.status === 'SCHEDULED');
      
      if (pendingRequest) {
        return res.status(400).json({ message: "You already have a pending deletion request" });
      }
      
      const scheduledDeletionAt = new Date();
      scheduledDeletionAt.setDate(scheduledDeletionAt.getDate() + 30);
      
      const deletionRequest = await storage.createAccountDeletionRequest({
        userId: req.user!.id,
        reason,
        status: 'PENDING',
        scheduledDeletionAt,
      });
      
      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'USER_DEACTIVATED',
        resourceType: 'USER',
        resourceId: req.user!.id,
        resourceName: 'Account Deletion Request',
        metadata: { reason, scheduledDeletionAt },
      });
      
      res.status(201).json(deletionRequest);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/account-deletion", requireAuth, async (req, res, next) => {
    try {
      const requests = await storage.getAccountDeletionRequestsByUser(req.user!.id);
      res.json(requests);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/account-deletion/:id", requireAuth, async (req, res, next) => {
    try {
      const { id } = req.params;
      const request = await storage.getAccountDeletionRequest(id);
      
      if (!request || request.userId !== req.user!.id) {
        return res.status(404).json({ message: "Deletion request not found" });
      }
      
      if (request.status !== 'PENDING' && request.status !== 'SCHEDULED') {
        return res.status(400).json({ message: "Cannot cancel this request" });
      }
      
      const cancelled = await storage.updateAccountDeletionRequest(id, {
        status: 'CANCELLED',
        cancelledAt: new Date(),
      });
      
      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'USER_ACTIVATED',
        resourceType: 'USER',
        resourceId: req.user!.id,
        resourceName: 'Account Deletion Cancellation',
      });
      
      res.json(cancelled);
    } catch (error) {
      next(error);
    }
  });

  // Admin: View pending deletion requests
  app.get("/api/admin/account-deletion-requests", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const requests = await storage.getPendingAccountDeletionRequests();
      res.json(requests);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Approve deletion request
  app.patch("/api/admin/account-deletion-requests/:id/approve", requireRole("SUPER_ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const request = await storage.getAccountDeletionRequest(id);
      
      if (!request) {
        return res.status(404).json({ message: "Deletion request not found" });
      }
      
      const approved = await storage.updateAccountDeletionRequest(id, {
        status: 'SCHEDULED',
        adminApprovedBy: req.user!.id,
      });
      
      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: 'USER_DELETED',
        resourceType: 'USER',
        resourceId: request.userId,
        resourceName: 'Account Deletion Approved',
        metadata: { requestId: id, approvedBy: req.user!.id },
      });
      
      res.json(approved);
    } catch (error) {
      next(error);
    }
  });

  // =====================
  // Global Search Routes
  // =====================

  // Global search across all content types
  app.get("/api/search", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const query = (req.query.q as string) || '';
      const type = (req.query.type as string) || 'ALL';
      const limit = parseInt(req.query.limit as string) || 20;

      if (!query || query.length < 2) {
        return res.json({ users: [], messages: [], documents: [], tasks: [], goals: [], total: 0 });
      }

      const results: any = {
        users: [],
        messages: [],
        documents: [],
        tasks: [],
        goals: [],
        total: 0,
      };

      // Search users (admin can see all, others see limited)
      if (type === 'ALL' || type === 'USERS') {
        const allUsers = await storage.getAllUsers();
        results.users = allUsers
          .filter(u => 
            u.firstName.toLowerCase().includes(query.toLowerCase()) ||
            u.lastName.toLowerCase().includes(query.toLowerCase()) ||
            u.email.toLowerCase().includes(query.toLowerCase()) ||
            (u.organizationName && u.organizationName.toLowerCase().includes(query.toLowerCase()))
          )
          .slice(0, limit)
          .map(u => ({
            id: u.id,
            firstName: u.firstName,
            lastName: u.lastName,
            email: u.email,
            role: u.role,
            profileImage: u.profileImage,
            organizationName: u.organizationName,
          }));
      }

      // Search tasks
      if (type === 'ALL' || type === 'TASKS') {
        const allTasks = await storage.getTasks({ assignedToId: user.id });
        results.tasks = allTasks
          .filter((t: any) => 
            t.title.toLowerCase().includes(query.toLowerCase()) ||
            (t.description && t.description.toLowerCase().includes(query.toLowerCase()))
          )
          .slice(0, limit);
      }

      // Search goals
      if (type === 'ALL' || type === 'GOALS') {
        const allGoals = await storage.getGoals({ ownerId: user.id });
        results.goals = allGoals
          .filter((g: any) => 
            g.title.toLowerCase().includes(query.toLowerCase()) ||
            (g.description && g.description.toLowerCase().includes(query.toLowerCase()))
          )
          .slice(0, limit);
      }

      // Search documents (user's accessible documents)
      if (type === 'ALL' || type === 'DOCUMENTS') {
        const allDocuments = await storage.getDocuments({ uploadedById: user.id });
        results.documents = allDocuments
          .filter((d: any) => 
            d.name.toLowerCase().includes(query.toLowerCase()) ||
            (d.description && d.description.toLowerCase().includes(query.toLowerCase()))
          )
          .slice(0, limit);
      }

      results.total = results.users.length + results.tasks.length + 
                      results.goals.length + results.documents.length;

      // Save search history
      await storage.createSearchHistory({
        userId: user.id,
        query,
        searchType: type as any,
        resultCount: results.total,
      });

      res.json(results);
    } catch (error) {
      next(error);
    }
  });

  // Get search history
  app.get("/api/search/history", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const history = await storage.getSearchHistory(user.id, 10);
      res.json(history);
    } catch (error) {
      next(error);
    }
  });

  // Clear search history
  app.delete("/api/search/history", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      await storage.clearSearchHistory(user.id);
      res.json({ message: "Search history cleared" });
    } catch (error) {
      next(error);
    }
  });

  // Saved searches
  app.get("/api/search/saved", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const saved = await storage.getSavedSearches(user.id);
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/search/saved", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const saved = await storage.createSavedSearch({
        userId: user.id,
        name: req.body.name,
        query: req.body.query,
        searchType: req.body.searchType || 'ALL',
        filters: req.body.filters,
      });
      res.status(201).json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/search/saved/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      await storage.deleteSavedSearch(req.params.id, user.id);
      res.json({ message: "Saved search deleted" });
    } catch (error) {
      next(error);
    }
  });

  // =====================
  // Survey Routes
  // =====================

  // Get all surveys (admin only)
  app.get("/api/surveys", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const surveys = await storage.getSurveys();
      res.json(surveys);
    } catch (error) {
      next(error);
    }
  });

  // Create survey
  app.post("/api/surveys", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const user = req.user as any;
      const survey = await storage.createSurvey({
        ...req.body,
        createdById: user.id,
      });
      res.status(201).json(survey);
    } catch (error) {
      next(error);
    }
  });

  // Get survey by ID
  app.get("/api/surveys/:id", requireAuth, async (req, res, next) => {
    try {
      const survey = await storage.getSurvey(req.params.id);
      if (!survey) {
        return res.status(404).json({ message: "Survey not found" });
      }
      res.json(survey);
    } catch (error) {
      next(error);
    }
  });

  // Update survey
  app.patch("/api/surveys/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const survey = await storage.updateSurvey(req.params.id, req.body);
      res.json(survey);
    } catch (error) {
      next(error);
    }
  });

  // Submit survey response
  app.post("/api/surveys/:id/responses", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const survey = await storage.getSurvey(req.params.id);
      
      if (!survey) {
        return res.status(404).json({ message: "Survey not found" });
      }
      
      if (survey.status !== 'ACTIVE') {
        return res.status(400).json({ message: "Survey is not active" });
      }

      const response = await storage.createSurveyResponse({
        surveyId: req.params.id,
        userId: survey.isAnonymous ? null : user.id,
        responses: req.body.responses,
      });
      
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  });

  // Get survey responses (admin only)
  app.get("/api/surveys/:id/responses", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const responses = await storage.getSurveyResponses(req.params.id);
      res.json(responses);
    } catch (error) {
      next(error);
    }
  });

  // Delete survey (admin only) — removes the survey and its responses.
  app.delete("/api/surveys/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const survey = await storage.getSurvey(req.params.id);
      if (!survey) {
        return res.status(404).json({ message: "Survey not found" });
      }
      await storage.deleteSurvey(req.params.id);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // =====================
  // Onboarding Routes
  // =====================

  // Onboarding checklist for the current user. Progress is DERIVED from real
  // activity (profile, CoC, match, goal, message, meeting) rather than the
  // onboarding_progress flag columns, so it's accurate without per-action
  // instrumentation. Returned steps are ordered; the client renders labels.
  app.get("/api/onboarding/progress", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;

      const [profile, cocRows, matches, goals, sentMessage, meetings] = await Promise.all([
        storage.getUser(user.id),
        db.select({ id: cocAcceptancesTable.id }).from(cocAcceptancesTable)
          .where(eq(cocAcceptancesTable.userId, user.id)).limit(1),
        storage.getMatchesForUser(user.id),
        storage.getGoals({ ownerId: user.id }),
        db.select({ id: messagesTable.id }).from(messagesTable)
          .where(eq(messagesTable.senderId, user.id)).limit(1),
        storage.getMeetingsForUser(user.id),
      ]);

      const steps = [
        { key: "profile", done: !!(profile?.bio || profile?.jobTitle || profile?.profileImage) },
        { key: "coc", done: cocRows.length > 0 },
        { key: "match", done: matches.length > 0 },
        { key: "goal", done: goals.length > 0 },
        { key: "message", done: sentMessage.length > 0 },
        { key: "meeting", done: meetings.some((m) => !!m.actualDate) },
      ];

      res.json({
        steps,
        completed: steps.filter((s) => s.done).length,
        total: steps.length,
      });
    } catch (error) {
      next(error);
    }
  });

  // =====================
  // Code of Conduct Routes
  // =====================

  // Check whether current user has signed the CoC
  app.get("/api/onboarding/coc", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const [acceptance] = await db.select().from(cocAcceptancesTable)
        .where(eq(cocAcceptancesTable.userId, user.id))
        .limit(1);
      res.json({ signed: !!acceptance, acceptance: acceptance ?? null });
    } catch (error) {
      next(error);
    }
  });

  // Submit signed CoC
  app.post("/api/onboarding/coc", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const { firstName, lastName, email, signatureData, version } = req.body;

      if (!firstName || !lastName || !email || !signatureData) {
        return res.status(400).json({ message: "First name, last name, email, and signature are required" });
      }

      // Idempotent — don't create duplicates
      const [existing] = await db.select().from(cocAcceptancesTable)
        .where(eq(cocAcceptancesTable.userId, user.id))
        .limit(1);
      if (existing) {
        return res.json({ success: true, alreadySigned: true, acceptance: existing });
      }

      const ipAddress = req.headers["x-forwarded-for"]?.toString()?.split(",")[0]?.trim()
        ?? req.socket?.remoteAddress
        ?? null;
      const userAgent = req.headers["user-agent"] ?? null;

      const [acceptance] = await db.insert(cocAcceptancesTable).values({
        userId: user.id,
        version: version ?? "2026",
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.toLowerCase().trim(),
        signatureData,
        ipAddress,
        userAgent,
      }).returning();

      // Flip the gate flag on the user
      await storage.updateUser(user.id, { hasSignedCoc: true } as any);

      const audit = AuditService.fromRequest(req);
      await audit.log({
        action: "COC_SIGNED",
        resourceType: "USER",
        resourceId: user.id,
        resourceName: user.email,
        metadata: { version: version ?? "2026", cocAcceptanceId: acceptance.id },
      });

      res.json({ success: true, acceptance });
    } catch (error) {
      next(error);
    }
  });

  // Get onboarding progress
  app.get("/api/onboarding", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      let progress = await storage.getOnboardingProgress(user.id);
      
      if (!progress) {
        progress = await storage.createOnboardingProgress({ userId: user.id });
      }
      
      res.json(progress);
    } catch (error) {
      next(error);
    }
  });

  // Update onboarding progress
  app.patch("/api/onboarding", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const progress = await storage.updateOnboardingProgress(user.id, req.body);
      res.json(progress);
    } catch (error) {
      next(error);
    }
  });

  // =====================
  // Certificate Routes
  // =====================

  // Get certificates (users see their own, admins see all)
  app.get("/api/certificates", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const filters: { userId?: string; cohortId?: string; status?: string } = {};
      
      if (!["SUPER_ADMIN", "ADMIN"].includes(user.role)) {
        filters.userId = user.id;
      } else {
        if (req.query.userId) filters.userId = req.query.userId as string;
        if (req.query.cohortId) filters.cohortId = req.query.cohortId as string;
        if (req.query.status) filters.status = req.query.status as string;
      }
      
      const certs = await storage.getCertificates(filters);
      res.json(certs);
    } catch (error) {
      next(error);
    }
  });

  // Get single certificate
  app.get("/api/certificates/:id", requireAuth, async (req, res, next) => {
    try {
      const cert = await storage.getCertificate(req.params.id);
      if (!cert) {
        return res.status(404).json({ message: "Certificate not found" });
      }
      
      const user = req.user as any;
      if (!["SUPER_ADMIN", "ADMIN"].includes(user.role) && cert.userId !== user.id) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      res.json(cert);
    } catch (error) {
      next(error);
    }
  });

  // Verify certificate by number (public endpoint)
  app.get("/api/certificates/verify/:certificateNumber", async (req, res, next) => {
    try {
      const cert = await storage.getCertificateByNumber(req.params.certificateNumber);
      if (!cert) {
        return res.status(404).json({ valid: false, message: "Certificate not found" });
      }
      
      // Only return public fields for verification
      const publicCert = {
        certificateNumber: cert.certificateNumber,
        status: cert.status,
        issuedAt: cert.issuedAt,
        expiresAt: cert.expiresAt,
      };
      
      if (cert.status === "REVOKED") {
        return res.json({ valid: false, message: "Certificate has been revoked", certificate: publicCert });
      }
      
      if (cert.expiresAt && new Date(cert.expiresAt) < new Date()) {
        return res.json({ valid: false, message: "Certificate has expired", certificate: publicCert });
      }
      
      res.json({ valid: true, certificate: publicCert });
    } catch (error) {
      next(error);
    }
  });

  // Issue certificate (admin only)
  const issueCertificateInputSchema = insertCertificateSchema
    .omit({ certificateNumber: true, status: true, verificationUrl: true, issuedAt: true })
    .extend({
      cohortId: z.string().nullish().transform(val => val && val.trim() ? val : null),
      templateData: z.record(z.unknown()).optional().default({}),
      expiresAt: z.string().nullish()
        .transform(val => {
          if (!val) return null;
          const date = new Date(val);
          return isNaN(date.getTime()) ? null : date;
        })
        .refine(val => val === null || val instanceof Date, { message: "Invalid date format" }),
    });

  app.post("/api/certificates", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      // Validate request body using shared schema
      const parseResult = issueCertificateInputSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          message: "Validation failed", 
          errors: parseResult.error.flatten().fieldErrors 
        });
      }
      
      const { userId, cohortId, templateData, expiresAt } = parseResult.data;
      
      // Generate unique certificate number with retry loop
      let certificate = null;
      let retries = 3;
      
      while (retries > 0) {
        const certificateNumber = `SONSIEL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        
        try {
          certificate = await storage.createCertificate({
            userId,
            cohortId,
            certificateNumber,
            status: "GENERATED",
            templateData,
            issuedAt: new Date(),
            expiresAt,
            verificationUrl: `/verify/${certificateNumber}`,
          });
          break; // Success, exit loop
        } catch (error: any) {
          if (error?.code === '23505' || error?.message?.includes('unique constraint')) {
            retries--;
            if (retries === 0) {
              return res.status(409).json({ message: "Failed to generate unique certificate number. Please try again." });
            }
            continue; // Retry with new number
          }
          throw error; // Re-throw non-duplicate errors
        }
      }
      
      res.status(201).json(certificate);
    } catch (error) {
      next(error);
    }
  });

  // Update certificate status (admin only)
  app.patch("/api/certificates/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const certificate = await storage.updateCertificate(req.params.id, req.body);
      if (!certificate) {
        return res.status(404).json({ message: "Certificate not found" });
      }
      res.json(certificate);
    } catch (error) {
      next(error);
    }
  });

  // =====================
  // Mentor Community Board Routes
  // =====================

  // Check community board access
  app.get("/api/community/access", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can access the community board
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.json({ hasAccess: false, reason: "NOT_MENTOR" });
      }
      
      const access = await storage.getCommunityBoardAccess(user.id);
      
      if (!access) {
        // Auto-grant access to mentors who don't have a record yet
        if (user.role === "MENTOR") {
          await storage.grantCommunityBoardAccess(user.id);
          return res.json({ hasAccess: true, status: "ACTIVE" });
        }
        // Admins always have access
        if (["ADMIN", "SUPER_ADMIN"].includes(user.role)) {
          return res.json({ hasAccess: true, status: "ADMIN" });
        }
        return res.json({ hasAccess: false, reason: "NO_ACCESS" });
      }
      
      if (access.status === "REVOKED") {
        return res.json({ 
          hasAccess: false, 
          reason: "REVOKED",
          revokedAt: access.revokedAt,
          revokedReason: access.revokedReason
        });
      }
      
      return res.json({ hasAccess: true, status: access.status });
    } catch (error) {
      next(error);
    }
  });

  // Admin: Get all community board access records
  app.get("/api/admin/community/access", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const accessRecords = await storage.getAllCommunityBoardAccess();
      res.json(accessRecords);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Grant community board access
  app.post("/api/admin/community/access/:userId/grant", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const admin = req.user as any;
      const access = await storage.grantCommunityBoardAccess(req.params.userId, admin.id);
      res.json(access);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Revoke community board access
  app.post("/api/admin/community/access/:userId/revoke", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const admin = req.user as any;
      const { reason } = req.body;
      const access = await storage.revokeCommunityBoardAccess(req.params.userId, admin.id, reason);
      res.json(access);
    } catch (error) {
      next(error);
    }
  });

  // Get thread categories
  app.get("/api/community/categories", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can access community categories
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Community board access denied", reason: "NOT_MENTOR" });
      }
      
      // Check access status for mentors
      if (user.role === "MENTOR") {
        const access = await storage.getCommunityBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Community board access revoked", reason: "REVOKED" });
        }
      }
      
      const categories = await storage.getThreadCategories(true);
      res.json(categories);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Manage thread categories
  app.post("/api/admin/community/categories", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const validatedData = insertThreadCategorySchema.parse(req.body);
      const category = await storage.createThreadCategory(validatedData);
      res.status(201).json(category);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/admin/community/categories/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const category = await storage.updateThreadCategory(req.params.id, req.body);
      res.json(category);
    } catch (error) {
      next(error);
    }
  });

  // Get community threads
  app.get("/api/community/threads", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can access community board
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Community board access denied", reason: "NOT_MENTOR" });
      }
      
      // Check access status for mentors (admins always have access)
      if (user.role === "MENTOR") {
        const access = await storage.getCommunityBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Community board access revoked", reason: "REVOKED" });
        }
      }
      
      const { categoryId, search, sortBy, limit, offset } = req.query;
      
      const threads = await storage.getCommunityThreads({
        categoryId: categoryId as string,
        search: search as string,
        sortBy: sortBy as 'recent' | 'created' | 'replies',
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });
      
      res.json(threads);
    } catch (error) {
      next(error);
    }
  });

  // Get single thread with details
  app.get("/api/community/threads/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can access community board
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Community board access denied", reason: "NOT_MENTOR" });
      }
      
      // Check access status for mentors
      if (user.role === "MENTOR") {
        const access = await storage.getCommunityBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Community board access revoked", reason: "REVOKED" });
        }
      }
      
      const thread = await storage.getCommunityThread(req.params.id);
      if (!thread) {
        return res.status(404).json({ message: "Thread not found" });
      }
      
      // Increment view count
      await storage.incrementThreadViewCount(req.params.id);
      
      // Get replies
      const replies = await storage.getThreadReplies(req.params.id);
      
      res.json({ ...thread, replies });
    } catch (error) {
      next(error);
    }
  });

  // Create new thread
  app.post("/api/community/threads", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can create threads
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Community board access denied", reason: "NOT_MENTOR" });
      }
      
      // Check access status for mentors
      if (user.role === "MENTOR") {
        const access = await storage.getCommunityBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Community board access revoked", reason: "REVOKED" });
        }
      }
      
      const validatedData = insertCommunityThreadSchema.parse({
        ...req.body,
        authorId: user.id,
      });
      
      const thread = await storage.createCommunityThread(validatedData);
      res.status(201).json(thread);
    } catch (error) {
      next(error);
    }
  });

  // Update thread (author only within 24 hours, or admin)
  app.patch("/api/community/threads/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can access community board
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Community board access denied", reason: "NOT_MENTOR" });
      }
      
      // Check access status for mentors
      if (user.role === "MENTOR") {
        const access = await storage.getCommunityBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Community board access revoked", reason: "REVOKED" });
        }
      }
      
      const thread = await storage.getCommunityThread(req.params.id);
      
      if (!thread) {
        return res.status(404).json({ message: "Thread not found" });
      }
      
      // Check if user can edit (author within 24 hours or admin)
      const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(user.role);
      const isAuthor = thread.authorId === user.id;
      const withinEditWindow = thread.createdAt && (Date.now() - new Date(thread.createdAt).getTime()) < 24 * 60 * 60 * 1000;
      
      if (!isAdmin && !(isAuthor && withinEditWindow)) {
        return res.status(403).json({ message: "Cannot edit this thread. Editing is only allowed within 24 hours of creation." });
      }
      
      const { title, content, categoryId } = req.body;
      const updated = await storage.updateCommunityThread(req.params.id, { title, content, categoryId });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Delete thread (author only within 24 hours, or admin)
  app.delete("/api/community/threads/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can access community board
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Community board access denied", reason: "NOT_MENTOR" });
      }
      
      // Check access status for mentors
      if (user.role === "MENTOR") {
        const access = await storage.getCommunityBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Community board access revoked", reason: "REVOKED" });
        }
      }
      
      const thread = await storage.getCommunityThread(req.params.id);
      
      if (!thread) {
        return res.status(404).json({ message: "Thread not found" });
      }
      
      // Check if user can delete (author within 24 hours or admin)
      const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(user.role);
      const isAuthor = thread.authorId === user.id;
      const withinEditWindow = thread.createdAt && (Date.now() - new Date(thread.createdAt).getTime()) < 24 * 60 * 60 * 1000;
      
      if (!isAdmin && !(isAuthor && withinEditWindow)) {
        return res.status(403).json({ message: "Cannot delete this thread. Deletion is only allowed within 24 hours of creation." });
      }
      
      await storage.deleteCommunityThread(req.params.id);
      res.json({ message: "Thread deleted" });
    } catch (error) {
      next(error);
    }
  });

  // Admin: Pin/Unpin thread
  app.post("/api/community/threads/:id/pin", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const user = req.user as any;
      const thread = await storage.pinThread(req.params.id, user.id);
      res.json(thread);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/community/threads/:id/unpin", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const thread = await storage.unpinThread(req.params.id);
      res.json(thread);
    } catch (error) {
      next(error);
    }
  });

  // Get thread replies
  app.get("/api/community/threads/:id/replies", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can access community board
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Community board access denied", reason: "NOT_MENTOR" });
      }
      
      // Check access status for mentors
      if (user.role === "MENTOR") {
        const access = await storage.getCommunityBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Community board access revoked", reason: "REVOKED" });
        }
      }
      
      const replies = await storage.getThreadReplies(req.params.id);
      res.json(replies);
    } catch (error) {
      next(error);
    }
  });

  // Create reply
  app.post("/api/community/threads/:id/replies", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can create replies
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Community board access denied", reason: "NOT_MENTOR" });
      }
      
      // Check access status for mentors
      if (user.role === "MENTOR") {
        const access = await storage.getCommunityBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Community board access revoked", reason: "REVOKED" });
        }
      }
      
      const thread = await storage.getCommunityThread(req.params.id);
      if (!thread) {
        return res.status(404).json({ message: "Thread not found" });
      }
      
      if (thread.isLocked) {
        return res.status(403).json({ message: "This thread is locked" });
      }
      
      const validatedData = insertThreadReplySchema.parse({
        threadId: req.params.id,
        authorId: user.id,
        content: req.body.content,
        parentReplyId: req.body.parentReplyId,
      });
      
      const reply = await storage.createThreadReply(validatedData);
      res.status(201).json(reply);
    } catch (error) {
      next(error);
    }
  });

  // Update reply (author only within 24 hours, or admin)
  app.patch("/api/community/replies/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can access community board
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Community board access denied", reason: "NOT_MENTOR" });
      }
      
      // Check access status for mentors
      if (user.role === "MENTOR") {
        const access = await storage.getCommunityBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Community board access revoked", reason: "REVOKED" });
        }
      }
      
      const reply = await storage.getThreadReply(req.params.id);
      
      if (!reply) {
        return res.status(404).json({ message: "Reply not found" });
      }
      
      // Check if user can edit (author within 24 hours or admin)
      const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(user.role);
      const isAuthor = reply.authorId === user.id;
      const withinEditWindow = reply.createdAt && (Date.now() - new Date(reply.createdAt).getTime()) < 24 * 60 * 60 * 1000;
      
      if (!isAdmin && !(isAuthor && withinEditWindow)) {
        return res.status(403).json({ message: "Cannot edit this reply. Editing is only allowed within 24 hours of creation." });
      }
      
      const updated = await storage.updateThreadReply(req.params.id, req.body.content);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Delete reply (author only within 24 hours, or admin)
  app.delete("/api/community/replies/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentors and admins can access community board
      if (!["MENTOR", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Community board access denied", reason: "NOT_MENTOR" });
      }
      
      // Check access status for mentors
      if (user.role === "MENTOR") {
        const access = await storage.getCommunityBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Community board access revoked", reason: "REVOKED" });
        }
      }
      
      const reply = await storage.getThreadReply(req.params.id);
      
      if (!reply) {
        return res.status(404).json({ message: "Reply not found" });
      }
      
      // Check if user can delete (author within 24 hours or admin)
      const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(user.role);
      const isAuthor = reply.authorId === user.id;
      const withinEditWindow = reply.createdAt && (Date.now() - new Date(reply.createdAt).getTime()) < 24 * 60 * 60 * 1000;
      
      if (!isAdmin && !(isAuthor && withinEditWindow)) {
        return res.status(403).json({ message: "Cannot delete this reply. Deletion is only allowed within 24 hours of creation." });
      }
      
      await storage.deleteThreadReply(req.params.id);
      res.json({ message: "Reply deleted" });
    } catch (error) {
      next(error);
    }
  });

  // ================== MENTEE COMMUNITY BOARD ==================
  
  // Check mentee board access status
  app.get("/api/mentee-community/access", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can access mentee community
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ 
          hasAccess: false, 
          reason: "NOT_MENTEE",
          message: "Mentee Community Board is only accessible to mentees."
        });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ 
            hasAccess: false, 
            reason: "REVOKED",
            message: "Your access to the Mentee Community Board has been revoked."
          });
        }
      }
      
      res.json({ hasAccess: true });
    } catch (error) {
      next(error);
    }
  });

  // Admin: Grant mentee board access
  app.post("/api/admin/mentee-community/access/:userId/grant", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const adminUser = req.user as any;
      const access = await storage.grantMenteeBoardAccess(req.params.userId, adminUser.id);
      res.json(access);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Revoke mentee board access
  app.post("/api/admin/mentee-community/access/:userId/revoke", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const adminUser = req.user as any;
      const { reason } = req.body;
      const access = await storage.revokeMenteeBoardAccess(req.params.userId, adminUser.id, reason);
      res.json(access);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Get all mentee board access records
  app.get("/api/admin/mentee-community/access", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const accessRecords = await storage.getAllMenteeBoardAccess();
      res.json(accessRecords);
    } catch (error) {
      next(error);
    }
  });

  // Get mentee thread categories
  app.get("/api/mentee-community/categories", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can access mentee community categories
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Mentee community board access denied", reason: "NOT_MENTEE" });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Mentee community board access revoked", reason: "REVOKED" });
        }
      }
      
      const categories = await storage.getMenteeThreadCategories(true);
      res.json(categories);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Manage mentee thread categories
  app.post("/api/admin/mentee-community/categories", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const category = await storage.createMenteeThreadCategory(req.body);
      res.status(201).json(category);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/admin/mentee-community/categories/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const category = await storage.updateMenteeThreadCategory(req.params.id, req.body);
      res.json(category);
    } catch (error) {
      next(error);
    }
  });

  // Get mentee threads
  app.get("/api/mentee-community/threads", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can access mentee community threads
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Mentee community board access denied", reason: "NOT_MENTEE" });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Mentee community board access revoked", reason: "REVOKED" });
        }
      }
      
      const { categoryId, search, sortBy } = req.query;
      const threads = await storage.getMenteeThreads({
        categoryId: categoryId as string,
        search: search as string,
        sortBy: sortBy as 'recent' | 'created' | 'replies'
      });
      res.json(threads);
    } catch (error) {
      next(error);
    }
  });

  // Get single mentee thread
  app.get("/api/mentee-community/threads/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can access mentee community
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Mentee community board access denied", reason: "NOT_MENTEE" });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Mentee community board access revoked", reason: "REVOKED" });
        }
      }
      
      const thread = await storage.getMenteeThread(req.params.id);
      if (!thread) {
        return res.status(404).json({ message: "Thread not found" });
      }
      
      // Increment view count
      await storage.incrementMenteeThreadViewCount(req.params.id);
      
      res.json(thread);
    } catch (error) {
      next(error);
    }
  });

  // Create new mentee thread
  app.post("/api/mentee-community/threads", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can create threads
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Mentee community board access denied", reason: "NOT_MENTEE" });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Mentee community board access revoked", reason: "REVOKED" });
        }
      }
      
      const { title, content, categoryId } = req.body;
      const thread = await storage.createMenteeThread({
        title,
        content,
        categoryId,
        authorId: user.id,
      });
      res.status(201).json(thread);
    } catch (error) {
      next(error);
    }
  });

  // Update mentee thread (author only within 24 hours, or admin)
  app.patch("/api/mentee-community/threads/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can access mentee community
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Mentee community board access denied", reason: "NOT_MENTEE" });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Mentee community board access revoked", reason: "REVOKED" });
        }
      }
      
      const thread = await storage.getMenteeThread(req.params.id);
      
      if (!thread) {
        return res.status(404).json({ message: "Thread not found" });
      }
      
      // Check if user can edit (author within 24 hours or admin)
      const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(user.role);
      const isAuthor = thread.authorId === user.id;
      const withinEditWindow = thread.createdAt && (Date.now() - new Date(thread.createdAt).getTime()) < 24 * 60 * 60 * 1000;
      
      if (!isAdmin && !(isAuthor && withinEditWindow)) {
        return res.status(403).json({ message: "Cannot edit this thread. Editing is only allowed within 24 hours of creation." });
      }
      
      const { title, content, categoryId } = req.body;
      const updated = await storage.updateMenteeThread(req.params.id, { title, content, categoryId });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Delete mentee thread (author only within 24 hours, or admin)
  app.delete("/api/mentee-community/threads/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can access mentee community
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Mentee community board access denied", reason: "NOT_MENTEE" });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Mentee community board access revoked", reason: "REVOKED" });
        }
      }
      
      const thread = await storage.getMenteeThread(req.params.id);
      
      if (!thread) {
        return res.status(404).json({ message: "Thread not found" });
      }
      
      // Check if user can delete (author within 24 hours or admin)
      const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(user.role);
      const isAuthor = thread.authorId === user.id;
      const withinEditWindow = thread.createdAt && (Date.now() - new Date(thread.createdAt).getTime()) < 24 * 60 * 60 * 1000;
      
      if (!isAdmin && !(isAuthor && withinEditWindow)) {
        return res.status(403).json({ message: "Cannot delete this thread. Deletion is only allowed within 24 hours of creation." });
      }
      
      await storage.deleteMenteeThread(req.params.id);
      res.json({ message: "Thread deleted" });
    } catch (error) {
      next(error);
    }
  });

  // Admin: Pin/Unpin mentee thread
  app.post("/api/mentee-community/threads/:id/pin", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const user = req.user as any;
      const thread = await storage.pinMenteeThread(req.params.id, user.id);
      res.json(thread);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/mentee-community/threads/:id/unpin", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const thread = await storage.unpinMenteeThread(req.params.id);
      res.json(thread);
    } catch (error) {
      next(error);
    }
  });

  // Get mentee thread replies
  app.get("/api/mentee-community/threads/:id/replies", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can access mentee community
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Mentee community board access denied", reason: "NOT_MENTEE" });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Mentee community board access revoked", reason: "REVOKED" });
        }
      }
      
      const replies = await storage.getMenteeThreadReplies(req.params.id);
      res.json(replies);
    } catch (error) {
      next(error);
    }
  });

  // Create mentee reply
  app.post("/api/mentee-community/threads/:id/replies", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can create replies
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Mentee community board access denied", reason: "NOT_MENTEE" });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Mentee community board access revoked", reason: "REVOKED" });
        }
      }
      
      const { content, parentReplyId } = req.body;
      const reply = await storage.createMenteeThreadReply({
        threadId: req.params.id,
        authorId: user.id,
        content,
        parentReplyId,
      });
      res.status(201).json(reply);
    } catch (error) {
      next(error);
    }
  });

  // Update mentee reply (author only within 24 hours, or admin)
  app.patch("/api/mentee-community/replies/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can access mentee community
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Mentee community board access denied", reason: "NOT_MENTEE" });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Mentee community board access revoked", reason: "REVOKED" });
        }
      }
      
      const reply = await storage.getMenteeThreadReply(req.params.id);
      
      if (!reply) {
        return res.status(404).json({ message: "Reply not found" });
      }
      
      // Check if user can edit (author within 24 hours or admin)
      const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(user.role);
      const isAuthor = reply.authorId === user.id;
      const withinEditWindow = reply.createdAt && (Date.now() - new Date(reply.createdAt).getTime()) < 24 * 60 * 60 * 1000;
      
      if (!isAdmin && !(isAuthor && withinEditWindow)) {
        return res.status(403).json({ message: "Cannot edit this reply. Editing is only allowed within 24 hours of creation." });
      }
      
      const { content } = req.body;
      const updated = await storage.updateMenteeThreadReply(req.params.id, content);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Delete mentee reply (author only within 24 hours, or admin)
  app.delete("/api/mentee-community/replies/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Only mentees and admins can access mentee community
      if (!["MENTEE", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
        return res.status(403).json({ message: "Mentee community board access denied", reason: "NOT_MENTEE" });
      }
      
      // Check access status for mentees
      if (user.role === "MENTEE") {
        const access = await storage.getMenteeBoardAccess(user.id);
        if (access && access.status === "REVOKED") {
          return res.status(403).json({ message: "Mentee community board access revoked", reason: "REVOKED" });
        }
      }
      
      const reply = await storage.getMenteeThreadReply(req.params.id);
      
      if (!reply) {
        return res.status(404).json({ message: "Reply not found" });
      }
      
      // Check if user can delete (author within 24 hours or admin)
      const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(user.role);
      const isAuthor = reply.authorId === user.id;
      const withinEditWindow = reply.createdAt && (Date.now() - new Date(reply.createdAt).getTime()) < 24 * 60 * 60 * 1000;
      
      if (!isAdmin && !(isAuthor && withinEditWindow)) {
        return res.status(403).json({ message: "Cannot delete this reply. Deletion is only allowed within 24 hours of creation." });
      }
      
      await storage.deleteMenteeThreadReply(req.params.id);
      res.json({ message: "Reply deleted" });
    } catch (error) {
      next(error);
    }
  });

  // ===== JOURNAL ENTRIES =====
  
  // Get user's own journal entries
  app.get("/api/journal", requireAuth, async (req, res, next) => {
    try {
      const entries = await storage.getJournalEntries(req.user!.id);
      res.json(entries);
    } catch (error) {
      next(error);
    }
  });

  // Get mentor's view of mentee journal entries
  app.get("/api/journal/mentee-entries", requireRole("MENTOR", "ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
    try {
      const entries = await storage.getJournalEntriesForMentor(req.user!.id);
      res.json(entries);
    } catch (error) {
      next(error);
    }
  });

  // Get single journal entry
  app.get("/api/journal/:id", requireAuth, async (req, res, next) => {
    try {
      const entry = await storage.getJournalEntry(req.params.id);
      if (!entry) {
        return res.status(404).json({ message: "Journal entry not found" });
      }
      
      // Only allow owner or mentor (if shared) to view
      const isOwner = entry.userId === req.user!.id;
      const isMentor = req.user!.role === "MENTOR" && (entry.visibility === "MENTOR_ONLY" || entry.visibility === "PUBLIC");
      const isAdmin = req.user!.role === "ADMIN" || req.user!.role === "SUPER_ADMIN";
      
      if (!isOwner && !isMentor && !isAdmin) {
        return res.status(403).json({ message: "Not authorized to view this entry" });
      }
      
      res.json(entry);
    } catch (error) {
      next(error);
    }
  });

  // Create journal entry
  app.post("/api/journal", requireAuth, async (req, res, next) => {
    try {
      const validated = insertJournalEntrySchema.parse({
        ...req.body,
        userId: req.user!.id,
      });
      const entry = await storage.createJournalEntry(validated);
      res.status(201).json(entry);
    } catch (error) {
      next(error);
    }
  });

  // Update journal entry
  app.patch("/api/journal/:id", requireAuth, async (req, res, next) => {
    try {
      const entry = await storage.getJournalEntry(req.params.id);
      if (!entry) {
        return res.status(404).json({ message: "Journal entry not found" });
      }
      if (entry.userId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to edit this entry" });
      }
      
      const updateSchema = insertJournalEntrySchema.partial();
      const validatedData = updateSchema.parse(req.body);
      const updated = await storage.updateJournalEntry(req.params.id, validatedData);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Delete journal entry
  app.delete("/api/journal/:id", requireAuth, async (req, res, next) => {
    try {
      const entry = await storage.getJournalEntry(req.params.id);
      if (!entry) {
        return res.status(404).json({ message: "Journal entry not found" });
      }
      if (entry.userId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to delete this entry" });
      }
      
      await storage.deleteJournalEntry(req.params.id);
      res.json({ message: "Journal entry deleted" });
    } catch (error) {
      next(error);
    }
  });

  // Add mentor feedback to journal entry
  app.post("/api/journal/:id/feedback", requireRole("MENTOR", "ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
    try {
      const entry = await storage.getJournalEntry(req.params.id);
      if (!entry) {
        return res.status(404).json({ message: "Journal entry not found" });
      }
      
      // Check if mentor has access to this entry
      if (entry.visibility === "PRIVATE") {
        return res.status(403).json({ message: "Cannot add feedback to private entries" });
      }
      
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== 'string') {
        return res.status(400).json({ message: "Feedback is required" });
      }
      
      const updated = await storage.addMentorFeedback(req.params.id, feedback);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // ============= REMINDERS ROUTES =============

  // Get reminders for current user (received reminders)
  app.get("/api/reminders", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const { status, type } = req.query;
      
      const filters: any = {
        recipientId: user.id,
      };
      if (status) filters.status = status as string;
      if (type) filters.type = type as string;
      
      const reminderList = await storage.getRemindersForUser(user.id);
      res.json(reminderList);
    } catch (error) {
      next(error);
    }
  });

  // Get reminders created by current user (for mentors to see their sent reminders)
  app.get("/api/reminders/created", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const reminderList = await storage.getRemindersCreatedByUser(user.id);
      res.json(reminderList);
    } catch (error) {
      next(error);
    }
  });

  // Admin: Get all reminders with user info
  app.get("/api/admin/reminders", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { status, type, recipientId, createdById } = req.query;
      
      if (status || type || recipientId || createdById) {
        const filters: any = {};
        if (status) filters.status = status as string;
        if (type) filters.type = type as string;
        if (recipientId) filters.recipientId = recipientId as string;
        if (createdById) filters.createdById = createdById as string;
        
        const reminderList = await storage.getReminders(filters);
        res.json(reminderList);
      } else {
        const reminderList = await storage.getAllRemindersWithUsers();
        res.json(reminderList);
      }
    } catch (error) {
      next(error);
    }
  });

  // Get single reminder
  app.get("/api/reminders/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const reminder = await storage.getReminder(req.params.id);
      
      if (!reminder) {
        return res.status(404).json({ message: "Reminder not found" });
      }
      
      // Check access: owner, recipient, or admin
      const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';
      if (reminder.createdById !== user.id && reminder.recipientId !== user.id && !isAdmin) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      res.json(reminder);
    } catch (error) {
      next(error);
    }
  });

  // Create reminder (Mentors can create for their mentees, Admins for anyone, Mentees for themselves)
  app.post("/api/reminders", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const { recipientId, type, ...rest } = req.body;
      
      // Determine the reminder type based on creator role
      let reminderType = type;
      if (!reminderType) {
        if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') {
          reminderType = 'ADMIN_ASSIGNED';
        } else if (user.role === 'MENTOR') {
          reminderType = 'MENTOR_ASSIGNED';
        } else {
          reminderType = 'PERSONAL';
        }
      }
      
      // Validate permissions
      if (reminderType === 'PERSONAL') {
        // Personal reminders must be for self
        if (recipientId && recipientId !== user.id) {
          return res.status(403).json({ message: "Personal reminders can only be set for yourself" });
        }
      } else if (reminderType === 'MENTOR_ASSIGNED') {
        // Mentors can only set reminders for their mentees
        if (user.role !== 'MENTOR' && user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
          return res.status(403).json({ message: "Only mentors can create mentor-assigned reminders" });
        }
        // Verify the recipient is actually an active mentee of this mentor
        // (admins bypass this check so they can create mentor-assigned reminders on behalf)
        if (recipientId && user.role === 'MENTOR') {
          const mentorMatches = await storage.getMatchesForUser(user.id);
          const menteeUserIds = await Promise.all(
            mentorMatches.map(async (m) => {
              const [mentorMembership, menteeMembership] = await Promise.all([
                storage.getMembership(m.mentorMembershipId),
                storage.getMembership(m.menteeMembershipId),
              ]);
              // Only include matches where this user is the mentor
              return mentorMembership?.userId === user.id ? menteeMembership?.userId : null;
            })
          );
          const isValidMentee = menteeUserIds.filter(Boolean).includes(recipientId);
          if (!isValidMentee) {
            return res.status(403).json({ message: "You can only create reminders for your own mentees" });
          }
        }
      } else if (reminderType === 'ADMIN_ASSIGNED') {
        if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
          return res.status(403).json({ message: "Only admins can create admin-assigned reminders" });
        }
      }
      
      const validated = insertReminderSchema.parse({
        ...rest,
        type: reminderType,
        createdById: user.id,
        recipientId: reminderType === 'PERSONAL' ? user.id : recipientId,
        dueDate: new Date(rest.dueDate),
        reminderTime: rest.reminderTime ? new Date(rest.reminderTime) : null,
      });
      
      const reminder = await storage.createReminder(validated);
      
      // Create notification for recipient if not personal
      if (reminder.recipientId && reminder.recipientId !== user.id) {
        await storage.createNotification({
          userId: reminder.recipientId,
          type: 'TASK_ASSIGNED',
          title: 'New Reminder',
          message: `You have a new reminder: ${reminder.title}`,
          priority: reminder.priority || 'NORMAL',
          resourceType: 'SYSTEM',
          resourceId: reminder.id,
        });
        
        emitNotification(reminder.recipientId, {
          type: 'TASK_ASSIGNED',
          title: 'New Reminder',
          message: `You have a new reminder: ${reminder.title}`,
        });
      }
      
      res.status(201).json(reminder);
    } catch (error) {
      next(error);
    }
  });

  // Update reminder
  app.patch("/api/reminders/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const reminder = await storage.getReminder(req.params.id);
      
      if (!reminder) {
        return res.status(404).json({ message: "Reminder not found" });
      }
      
      // Only creator or admin can update
      const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';
      if (reminder.createdById !== user.id && !isAdmin) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const updateData: any = { ...req.body };
      if (updateData.dueDate) updateData.dueDate = new Date(updateData.dueDate);
      if (updateData.reminderTime) updateData.reminderTime = new Date(updateData.reminderTime);
      
      const updated = await storage.updateReminder(req.params.id, updateData);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Delete reminder
  app.delete("/api/reminders/:id", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const reminder = await storage.getReminder(req.params.id);
      
      if (!reminder) {
        return res.status(404).json({ message: "Reminder not found" });
      }
      
      // Only creator or admin can delete
      const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';
      if (reminder.createdById !== user.id && !isAdmin) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      await storage.deleteReminder(req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // Mark reminder as completed (recipient can mark their received reminders)
  app.post("/api/reminders/:id/complete", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const reminder = await storage.getReminder(req.params.id);
      
      if (!reminder) {
        return res.status(404).json({ message: "Reminder not found" });
      }
      
      // Only recipient or admin can mark as complete
      const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';
      if (reminder.recipientId !== user.id && !isAdmin) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const updated = await storage.markReminderCompleted(req.params.id);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Dismiss reminder
  app.post("/api/reminders/:id/dismiss", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const reminder = await storage.getReminder(req.params.id);
      
      if (!reminder) {
        return res.status(404).json({ message: "Reminder not found" });
      }
      
      // Only recipient or admin can dismiss
      const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';
      if (reminder.recipientId !== user.id && !isAdmin) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const updated = await storage.markReminderDismissed(req.params.id);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Get mentees for mentor to assign reminders to
  app.get("/api/reminders/mentees", requireRole("MENTOR", "ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
    try {
      const user = req.user as any;
      
      // Get matches where user is mentor
      const matches = await storage.getMatchesForUser(user.id);
      const menteeMatches = matches.filter(m => m.status === 'ACTIVE' && m.mentor?.id === user.id);
      
      // Extract unique mentees
      const mentees = menteeMatches
        .map(m => m.mentee)
        .filter((m): m is NonNullable<typeof m> => m !== null && m !== undefined);
      
      res.json(mentees);
    } catch (error) {
      next(error);
    }
  });

  // ====== Programs & Multi-Program Support ======

  // Get programs the current user belongs to
  app.get("/api/programs", requireAuth, async (req, res, next) => {
    try {
      const userRole = req.user!.role;
      if (userRole === "SUPER_ADMIN" || userRole === "ADMIN") {
        const allPrograms = await storage.getAllPrograms();
        const memberships = await storage.getProgramMembershipsForUser(req.user!.id);
        const membershipMap = new Map(memberships.map(m => [m.programId, m]));
        const result = allPrograms.map(program => {
          const existing = membershipMap.get(program.id);
          if (existing) return existing;
          return {
            id: `virtual_${program.id}`,
            programId: program.id,
            userId: req.user!.id,
            role: userRole === "SUPER_ADMIN" ? "ADMIN" : userRole,
            isDefault: false,
            joinedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            program,
          };
        });
        res.json(result);
      } else {
        const memberships = await storage.getProgramMembershipsForUser(req.user!.id);
        res.json(memberships);
      }
    } catch (error) {
      next(error);
    }
  });

  // Set active program in session
  app.post("/api/programs/active", requireAuth, async (req, res, next) => {
    try {
      const { programId } = req.body;
      if (!programId) {
        return res.status(400).json({ message: "Program ID is required" });
      }
      const membership = await storage.getProgramMembership(programId, req.user!.id);
      const isSuperAdmin = req.user!.role === "SUPER_ADMIN";
      if (!membership && !isSuperAdmin) {
        return res.status(403).json({ message: "You are not a member of this program" });
      }
      (req.session as any).activeProgramId = programId;
      const program = await storage.getProgram(programId);
      res.json({ programId, program, membership: membership || null, role: membership?.role || (isSuperAdmin ? "ADMIN" : null) });
    } catch (error) {
      next(error);
    }
  });

  // Get current active program
  app.get("/api/programs/active", requireAuth, async (req, res, next) => {
    try {
      const activeProgramId = (req.session as any).activeProgramId;
      if (!activeProgramId) {
        return res.json({ programId: null, program: null, membership: null });
      }
      const program = await storage.getProgram(activeProgramId);
      const membership = await storage.getProgramMembership(activeProgramId, req.user!.id);
      res.json({ programId: activeProgramId, program, membership: membership || null, role: membership?.role || (req.user!.role === "SUPER_ADMIN" ? "ADMIN" : null) });
    } catch (error) {
      next(error);
    }
  });

  // Admin: list all programs
  app.get("/api/admin/programs", requireRole("SUPER_ADMIN"), async (req, res, next) => {
    try {
      const allPrograms = await storage.getAllPrograms();
      res.json(allPrograms);
    } catch (error) {
      next(error);
    }
  });

  // Admin: create program
  app.post("/api/admin/programs", requireRole("SUPER_ADMIN"), async (req, res, next) => {
    try {
      const { name, slug, description } = req.body;
      if (!name || !slug) {
        return res.status(400).json({ message: "Name and slug are required" });
      }
      const existing = await storage.getProgramBySlug(slug);
      if (existing) {
        return res.status(400).json({ message: "A program with this slug already exists" });
      }
      const program = await storage.createProgram({ name, slug, description: description || null, isActive: true });
      res.status(201).json(program);
    } catch (error) {
      next(error);
    }
  });

  // Admin: update program
  app.patch("/api/admin/programs/:id", requireRole("SUPER_ADMIN"), async (req, res, next) => {
    try {
      const { name, description, isActive } = req.body;
      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      if (isActive !== undefined) updateData.isActive = isActive;
      const program = await storage.updateProgram(req.params.id, updateData);
      if (!program) {
        return res.status(404).json({ message: "Program not found" });
      }
      res.json(program);
    } catch (error) {
      next(error);
    }
  });

  // Admin: get program members
  app.get("/api/admin/programs/:id/members", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const members = await storage.getProgramMembers(req.params.id);
      res.json(members);
    } catch (error) {
      next(error);
    }
  });

  // Admin: add member to program
  app.post("/api/admin/programs/:id/members", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { userId, role } = req.body;
      if (!userId || !role) {
        return res.status(400).json({ message: "User ID and role are required" });
      }
      if (!["ADMIN", "MENTOR", "MENTEE"].includes(role)) {
        return res.status(400).json({ message: "Invalid role" });
      }
      const existing = await storage.getProgramMembership(req.params.id, userId);
      if (existing) {
        return res.status(400).json({ message: "User is already a member of this program" });
      }
      const membership = await storage.createProgramMembership({
        programId: req.params.id,
        userId,
        role,
        isDefault: false,
      });
      res.status(201).json(membership);
    } catch (error) {
      next(error);
    }
  });

  // Admin: update program membership
  app.patch("/api/admin/program-memberships/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { role, isDefault } = req.body;
      const updateData: any = {};
      if (role !== undefined) updateData.role = role;
      if (isDefault !== undefined) updateData.isDefault = isDefault;
      const membership = await storage.updateProgramMembership(req.params.id, updateData);
      if (!membership) {
        return res.status(404).json({ message: "Membership not found" });
      }
      res.json(membership);
    } catch (error) {
      next(error);
    }
  });

  // Admin: remove member from program
  app.delete("/api/admin/program-memberships/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      await storage.deleteProgramMembership(req.params.id);
      res.sendStatus(204);
    } catch (error) {
      next(error);
    }
  });

  // Platform Status (public endpoint - no auth required)
  app.get("/api/platform-status", async (req, res, next) => {
    try {
      const issues = await storage.getPlatformIssues(false);
      const publicIssues = issues.map(({ createdById, ...rest }) => rest);
      res.json(publicIssues);
    } catch (error) {
      next(error);
    }
  });

  // Admin Platform Issues CRUD
  app.get("/api/admin/platform-issues", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const issues = await storage.getPlatformIssues(true);
      res.json(issues);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/platform-issues", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const user = req.user as any;
      const { title, description, status } = req.body;
      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ message: "Title is required" });
      }
      const validStatuses = ["INVESTIGATING", "IN_PROGRESS", "RESOLVED", "MONITORING"];
      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({ message: "Invalid status value" });
      }
      const issue = await storage.createPlatformIssue({
        title: title.trim(),
        description: description?.trim() || null,
        status: status || "INVESTIGATING",
        createdById: user.id,
      });
      res.status(201).json(issue);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/admin/platform-issues/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const { title, description, status } = req.body;
      const updateData: any = {};
      if (title !== undefined) {
        if (typeof title !== "string" || !title.trim()) {
          return res.status(400).json({ message: "Title cannot be empty" });
        }
        updateData.title = title.trim();
      }
      if (description !== undefined) {
        updateData.description = typeof description === "string" ? description.trim() || null : null;
      }
      const validStatuses = ["INVESTIGATING", "IN_PROGRESS", "RESOLVED", "MONITORING"];
      if (status !== undefined) {
        if (!validStatuses.includes(status)) {
          return res.status(400).json({ message: "Invalid status value" });
        }
        updateData.status = status;
      }
      const issue = await storage.updatePlatformIssue(req.params.id, updateData);
      if (!issue) {
        return res.status(404).json({ message: "Issue not found" });
      }
      res.json(issue);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/admin/platform-issues/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      await storage.deletePlatformIssue(req.params.id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // ==========================================
  // User Submissions (Issues & Suggestions)
  // ==========================================

  // User creates a submission
  app.post("/api/submissions", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const { type, title, description } = req.body;

      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ message: "Title is required" });
      }
      if (!description || typeof description !== "string" || !description.trim()) {
        return res.status(400).json({ message: "Description is required" });
      }
      const validTypes = ["ISSUE", "SUGGESTION"];
      if (!type || !validTypes.includes(type)) {
        return res.status(400).json({ message: "Type must be ISSUE or SUGGESTION" });
      }

      const submission = await storage.createUserSubmission({
        userId: user.id,
        type,
        title: title.trim(),
        description: description.trim(),
      });
      res.status(201).json(submission);
    } catch (error) {
      next(error);
    }
  });

  // User views their own submissions
  app.get("/api/submissions", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as any;
      const submissions = await storage.getUserSubmissions(user.id);
      res.json(submissions);
    } catch (error) {
      next(error);
    }
  });

  // Admin views all submissions
  app.get("/api/admin/submissions", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const submissions = await storage.getAllUserSubmissions();
      res.json(submissions);
    } catch (error) {
      next(error);
    }
  });

  // Admin updates a submission (status + response)
  app.patch("/api/admin/submissions/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
    try {
      const user = req.user as any;
      const { status, adminResponse } = req.body;
      const updateData: any = {};

      const validStatuses = ["SUBMITTED", "UNDER_REVIEW", "IN_PROGRESS", "COMPLETED", "DECLINED"];
      if (status !== undefined) {
        if (!validStatuses.includes(status)) {
          return res.status(400).json({ message: "Invalid status value" });
        }
        updateData.status = status;
      }
      if (adminResponse !== undefined) {
        const trimmed = typeof adminResponse === "string" ? adminResponse.trim() : "";
        updateData.adminResponse = trimmed || null;
        if (trimmed) {
          updateData.respondedById = user.id;
          updateData.respondedAt = new Date();
        }
      }

      const submission = await storage.updateUserSubmission(req.params.id, updateData);
      if (!submission) {
        return res.status(404).json({ message: "Submission not found" });
      }
      res.json(submission);
    } catch (error) {
      next(error);
    }
  });

  return httpServer;
}

// Compatibility calculation helper function
function calculateCompatibility(
  mentor: any,
  mentee: any,
  config: any
): { score: number; breakdown: Record<string, number>; flags: string[]; matchReason: string } {
  const breakdown: Record<string, number> = {};
  const flags: string[] = [];
  const reasons: string[] = [];

  // Language Match (25% default weight)
  const mentorLanguages = mentor.user.languagesSpoken || [];
  const menteeLanguages = mentee.user.languagesSpoken || [];
  const sharedLanguages = mentorLanguages.filter((lang: string) => menteeLanguages.includes(lang));
  
  let languageScore = 0;
  if (sharedLanguages.length > 0) {
    if (mentor.user.preferredLanguage === mentee.user.preferredLanguage) {
      languageScore = 100;
      reasons.push(`Primary language match: ${mentor.user.preferredLanguage}`);
    } else {
      languageScore = 50 + (sharedLanguages.length * 10);
      reasons.push(`Shared languages: ${sharedLanguages.join(', ')}`);
    }
  } else {
    flags.push('no_language_match');
    if (config.requireLanguageMatch) {
      reasons.push('WARNING: No language match');
    }
  }
  breakdown.language = languageScore;

  // Track Alignment (20% default weight)
  let trackScore = 0;
  if (mentor.trackId && mentee.trackId) {
    if (mentor.trackId === mentee.trackId) {
      trackScore = 100;
      reasons.push('Same track selected');
    } else {
      trackScore = 30;
    }
  }
  breakdown.track = trackScore;

  // Experience Level Match (10% default weight)
  let experienceScore = 0;
  const mentorExp = mentor.user.yearsOfExperience || 0;
  const menteeExp = mentee.user.yearsOfExperience || 0;
  const expDiff = mentorExp - menteeExp;
  
  if (expDiff >= 5 && expDiff <= 15) {
    experienceScore = 100;
    reasons.push('Good experience gap');
  } else if (expDiff >= 3 && expDiff <= 20) {
    experienceScore = 70;
  } else if (expDiff > 0) {
    experienceScore = 40;
  }
  breakdown.experience = experienceScore;

  // Availability Overlap (15% default weight) - simplified
  let availabilityScore = 50; // Default moderate score
  breakdown.availability = availabilityScore;

  // Expertise/Interest Match (25% default weight) - simplified
  let expertiseScore = 60; // Default moderate score
  breakdown.expertise = expertiseScore;

  // Communication Style (5% default weight) - simplified
  let communicationScore = 50;
  breakdown.communication = communicationScore;

  // Calculate weighted total
  const totalWeight = (config.languageWeight || 25) + (config.trackWeight || 20) + 
    (config.expertiseWeight || 25) + (config.availabilityWeight || 15) + 
    (config.experienceWeight || 10) + (config.communicationWeight || 5);

  const weightedScore = (
    (languageScore * (config.languageWeight || 25)) +
    (trackScore * (config.trackWeight || 20)) +
    (expertiseScore * (config.expertiseWeight || 25)) +
    (availabilityScore * (config.availabilityWeight || 15)) +
    (experienceScore * (config.experienceWeight || 10)) +
    (communicationScore * (config.communicationWeight || 5))
  ) / totalWeight;

  return {
    score: Math.round(weightedScore),
    breakdown,
    flags,
    matchReason: reasons.join('. '),
  };
}
