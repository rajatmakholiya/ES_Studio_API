import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User } from './entities/user.entity';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {}

  async login(email: string, pass: string) {
    const user = await this.userRepo.findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(pass, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.apiKey) {
      user.apiKey = crypto.randomBytes(32).toString('hex');
      await this.userRepo.save(user);
    }

    return {
      message: 'Login successful',
      apiKey: user.apiKey,
      email: user.email,
    };
  }

  async createAdminUser(email: string, plainTextPassword: string) {
    if (!email || !plainTextPassword) {
      throw new BadRequestException('Email and password are required');
    }
    const existingUser = await this.userRepo.findOne({ where: { email } });
    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(plainTextPassword, saltRounds);
    const apiKey = crypto.randomBytes(32).toString('hex');
    const newUser = this.userRepo.create({
      email,
      passwordHash,
      apiKey,
    });

    await this.userRepo.save(newUser);

    return {
      message: 'Admin account created successfully.',
      email: newUser.email,
      apiKey: newUser.apiKey,
    };
  }
}
