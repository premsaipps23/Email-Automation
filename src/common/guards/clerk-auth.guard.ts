import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { verifyToken, createClerkClient } from '@clerk/backend';

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private clerk = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
  });

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });

      // Fetch user from Clerk Backend API to check email domain
      const user = await this.clerk.users.getUser(decoded.sub);
      const email = user.emailAddresses?.find((e: any) => e.id === user.primaryEmailAddressId)?.emailAddress;

      if (!email || !email.endsWith('@techgrit.com')) {
        throw new UnauthorizedException('Access restricted to @techgrit.com domain users.');
      }

      request['user'] = {
        ...decoded,
        email,
      };
      return true;
    } catch (error) {
      throw new UnauthorizedException('Invalid auth token: ' + error.message);
    }
  }
}
