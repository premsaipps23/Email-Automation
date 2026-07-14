import { Controller, Get, Post, Body, Patch, Param, Delete, UseInterceptors, UploadedFile, UseGuards, Req } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EmployeeService } from './employee.service';
import { CreateEmployeeDto, UpdateEmployeeDto } from './dto/employee.dto';
import { ClerkAuthGuard } from '../../common/guards/clerk-auth.guard';

@Controller('employees')
@UseGuards(ClerkAuthGuard)
export class EmployeeController {
  constructor(private employeeService: EmployeeService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  uploadFile(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    const userEmail = req.user?.email;
    return this.employeeService.processExcel(file, userEmail);
  }

  @Post()
  create(@Body() createEmployeeDto: CreateEmployeeDto, @Req() req: any) {
    const userEmail = req.user?.email;
    return this.employeeService.create(createEmployeeDto, userEmail);
  }

  @Get()
  findAll(@Req() req: any) {
    const userEmail = req.user?.email;
    return this.employeeService.findAll(userEmail);
  }

  @Get('today-events')
  getTodayEvents(@Req() req: any) {
    const userEmail = req.user?.email;
    return this.employeeService.getTodayEvents(userEmail);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    const userEmail = req.user?.email;
    return this.employeeService.findOne(+id, userEmail);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateEmployeeDto: UpdateEmployeeDto, @Req() req: any) {
    const userEmail = req.user?.email;
    return this.employeeService.update(+id, updateEmployeeDto, userEmail);
  }

  @Post(':id/photo')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPhoto(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Req() req: any) {
    const userEmail = req.user?.email;
    return this.employeeService.saveEmployeeProfilePhoto(+id, file, userEmail);
  }

  @Post('bulk-delete')
  removeMultiple(@Body('ids') ids: number[], @Req() req: any) {
    const userEmail = req.user?.email;
    return this.employeeService.removeMultiple(ids, userEmail);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    const userEmail = req.user?.email;
    return this.employeeService.remove(+id, userEmail);
  }
}
