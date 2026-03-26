import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import {
  UserNotFoundException,
  AppException,
} from '../../common/filters/app-exception';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

const PREFERENCES_KEY_PREFIX = 'user:preferences:';
const DEFAULT_PREFERENCES: UserPreferences = {
  language: 'es',
  timezone: 'America/Mexico_City',
  theme: 'system',
  emailNotifications: true,
  pushNotifications: true,
  weeklyDigest: true,
};

export interface UserPreferences {
  language: string;
  timezone: string;
  theme: string;
  emailNotifications: boolean;
  pushNotifications: boolean;
  weeklyDigest: boolean;
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        organizationMembers: {
          select: {
            organizationId: true,
            joinedAt: true,
            organization: {
              select: { id: true, name: true, slug: true, logo: true },
            },
            role: {
              select: {
                id: true,
                name: true,
                rolePermissions: {
                  select: {
                    permission: {
                      select: { action: true, resource: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new UserNotFoundException(userId);
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      organizations: user.organizationMembers.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        logo: m.organization.logo,
        roleId: m.role.id,
        role: m.role.name,
        permissions: m.role.rolePermissions.map(
          (rp) => `${rp.permission.action}:${rp.permission.resource}`,
        ),
        joinedAt: m.joinedAt,
      })),
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new UserNotFoundException(userId);
    }

    const updateData: Record<string, any> = {};

    if (dto.name !== undefined) {
      updateData.name = dto.name;
    }

    if (dto.image !== undefined) {
      updateData.image = dto.image;
    }

    if (Object.keys(updateData).length === 0) {
      throw new AppException(
        'No se proporcionaron campos para actualizar',
        'NO_UPDATE_DATA',
        400,
      );
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        emailVerified: true,
        updatedAt: true,
      },
    });

    this.logger.log(`Profile updated for user: ${userId}`);

    return updatedUser;
  }

  async uploadAvatar(userId: string, file: Buffer, mimeType: string, originalName: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, image: true },
    });

    if (!user) {
      throw new UserNotFoundException(userId);
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedMimeTypes.includes(mimeType)) {
      throw new AppException(
        'Formato de imagen no soportado. Usa JPEG, PNG, WebP o GIF.',
        'INVALID_FILE_TYPE',
        400,
        { allowedTypes: allowedMimeTypes },
      );
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.length > maxSize) {
      throw new AppException(
        'La imagen no puede exceder 5MB',
        'FILE_TOO_LARGE',
        400,
        { maxSizeBytes: maxSize },
      );
    }

    const extension = mimeType.split('/')[1] || 'jpg';
    const key = `avatars/${userId}/${Date.now()}.${extension}`;

    await this.storage.upload(key, file, mimeType);
    const imageUrl = await this.storage.getSignedUrl(key);

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { image: key },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
      },
    });

    this.logger.log(`Avatar uploaded for user: ${userId}`);

    return {
      ...updatedUser,
      imageUrl,
    };
  }

  async getPreferences(userId: string): Promise<UserPreferences> {
    const raw = await this.redis.get(`${PREFERENCES_KEY_PREFIX}${userId}`);

    if (!raw) {
      return { ...DEFAULT_PREFERENCES };
    }

    try {
      const stored = JSON.parse(raw) as Partial<UserPreferences>;
      return { ...DEFAULT_PREFERENCES, ...stored };
    } catch {
      this.logger.warn(`Corrupted preferences data for user: ${userId}`);
      return { ...DEFAULT_PREFERENCES };
    }
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto): Promise<UserPreferences> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new UserNotFoundException(userId);
    }

    const current = await this.getPreferences(userId);

    const updated: UserPreferences = {
      language: dto.language ?? current.language,
      timezone: dto.timezone ?? current.timezone,
      theme: dto.theme ?? current.theme,
      emailNotifications: dto.emailNotifications ?? current.emailNotifications,
      pushNotifications: dto.pushNotifications ?? current.pushNotifications,
      weeklyDigest: dto.weeklyDigest ?? current.weeklyDigest,
    };

    await this.redis.set(
      `${PREFERENCES_KEY_PREFIX}${userId}`,
      JSON.stringify(updated),
    );

    this.logger.log(`Preferences updated for user: ${userId}`);

    return updated;
  }

  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UserNotFoundException(userId);
    }

    return user;
  }
}
