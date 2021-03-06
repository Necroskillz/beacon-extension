import { NgModule } from '@angular/core'
import { RouterModule, Routes } from '@angular/router'

import { AddWalletConnectionPage } from './add-wallet-connection.page'

const routes: Routes = [
  {
    path: '',
    component: AddWalletConnectionPage
  }
]

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class AddWalletConnectionPageRoutingModule {}
