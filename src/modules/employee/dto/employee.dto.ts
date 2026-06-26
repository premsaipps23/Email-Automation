import { IsString, IsEmail, IsDateString, IsOptional, IsNotEmpty } from 'class-validator';

export class CreateEmployeeDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsDateString()
  @IsNotEmpty()
  dob: string;

  @IsDateString()
  @IsNotEmpty()
  doj: string;

  @IsOptional()
  @IsString()
  photoUrl?: string;
}

export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

  @IsOptional()
  @IsDateString()
  doj?: string;

  @IsOptional()
  @IsString()
  photoUrl?: string;
}
