import {handleEnterpriseService} from '../../../../../lib/enterprise-service';

type RouteContext={params:Promise<{serviceId:string}>|{serviceId:string}};

export async function GET(request:Request,context:RouteContext){
  const {serviceId}=await context.params;
  return handleEnterpriseService(request,serviceId);
}

export async function POST(request:Request,context:RouteContext){
  const {serviceId}=await context.params;
  return handleEnterpriseService(request,serviceId);
}
