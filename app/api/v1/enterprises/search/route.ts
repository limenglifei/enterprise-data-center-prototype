import {handleEnterpriseService} from '../../../../../lib/enterprise-service';

export async function POST(request:Request){
  return handleEnterpriseService(request,'search');
}
