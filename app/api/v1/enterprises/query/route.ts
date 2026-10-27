import {handleEnterpriseService} from '../../../../../lib/enterprise-service';

export async function GET(request:Request){
  return handleEnterpriseService(request,'query');
}
